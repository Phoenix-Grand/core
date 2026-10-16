package com.kubuno.android.account

import android.app.Activity
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Bundle
import com.kubuno.android.api.SharedHttp
import com.kubuno.android.api.auth.BearerSource
import com.kubuno.android.api.auth.Jwt
import com.kubuno.android.api.net.AuthHeaderInterceptor
import com.kubuno.android.api.net.TokenAuthenticator
import com.kubuno.android.data.AppPrefs
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/**
 * An authenticated HTTP client for an account owned by another Kubuno app.
 *
 * [bearer] is exposed because some transports cannot carry an Authorization
 * header: the chat module's WebSocket takes its access token as a query
 * parameter, so its client needs a fresh one outside the interceptor chain.
 */
class BrokeredClient(
    val serverUrl: String,
    val okHttpClient: OkHttpClient,
    val bearer: BearerSource,
)

/**
 * Builds HTTP clients for accounts this app does NOT own - the ones a sibling
 * app (drive) signed in and shared through the system AccountManager.
 *
 * The refresh token stays in the owning app; this app only ever borrows
 * short-lived access tokens through `getAuthToken`, which the owner's
 * authenticator serves. A consumer app (mail) uses this instead of
 * [AccountClients] for accounts it did not create.
 */
@Singleton
class BrokeredClients @Inject constructor(
    @ApplicationContext private val context: Context,
    private val appPrefs: AppPrefs,
) {
    private val shared = SharedHttp()
    private val clients = ConcurrentHashMap<String, BrokeredClient>()

    /** A client acting as [account], keyed by its system name. */
    fun of(account: SharedAccount): BrokeredClient =
        clients.computeIfAbsent(account.systemName) { build(account) }

    /**
     * Drops the borrowed client for [account] so the next [of] rebuilds one
     * that re-fetches the access token. Call it after a re-authentication, when
     * the cached bearer would otherwise keep serving the now-dead token.
     */
    fun reset(account: SharedAccount) {
        clients.remove(account.systemName)
    }

    /**
     * Recovers a shared account whose session has died server-side.
     *
     * A consumer app never holds the refresh token - the owning app does - so
     * it cannot silently refresh a genuinely-dead session. Instead it asks the
     * system to re-authenticate: `getAuthToken` with a live [activity] surfaces
     * the account's sign-in (the authenticator returns it as an intent that the
     * framework launches), and once the user signs back in the owner rotates a
     * fresh session and hands back a new access token. This is the same
     * mechanism in every Kubuno app, so re-login is handled the same way
     * wherever the session expired, without sending anyone to another app by
     * hand. The stale borrowed client is dropped either way. Returns true when
     * a usable token came back.
     */
    suspend fun reauthenticate(activity: Activity, account: SharedAccount): Boolean =
        withContext(Dispatchers.IO) {
            val manager = AccountManager.get(context)
            val system = Account(account.systemName, KubunoAccounts.TYPE)
            val token = runCatching {
                // Blocks until the user finishes the launched sign-in.
                manager.getAuthToken(system, KubunoAccounts.AUTH_TOKEN_ACCESS, Bundle(), activity, null, null)
                    .result
                    .getString(AccountManager.KEY_AUTHTOKEN)
            }.getOrNull()
            reset(account)
            !token.isNullOrEmpty()
        }

    private fun build(account: SharedAccount): BrokeredClient {
        val bearer = BrokeredBearerSource(context, Account(account.systemName, KubunoAccounts.TYPE))
        val http = OkHttpClient.Builder()
            .connectionPool(shared.connectionPool)
            .dispatcher(okhttp3.Dispatcher(shared.executor))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(AuthHeaderInterceptor({ bearer }, { appPrefs.deviceKey }))
            .authenticator(TokenAuthenticator { bearer })
            .build()
        return BrokeredClient(account.serverUrl.trimEnd('/'), http, bearer)
    }
}

/**
 * Borrows access tokens for one shared account through the system
 * AccountManager.
 *
 * `blockingGetAuthToken` returns a cached token until it is invalidated, so we
 * track expiry from the JWT and invalidate proactively; on a 401 the
 * interceptor calls [refreshAfter401], which invalidates the failed token and
 * asks the owning app's authenticator for a new one. This process never holds
 * the refresh token - the owner rotates it, we only ever see 15-minute access
 * tokens.
 */
private class BrokeredBearerSource(
    context: Context,
    private val account: Account,
) : BearerSource {

    private val manager = AccountManager.get(context)

    @Volatile private var cached: String? = null

    override fun peekAccessToken(): String? = cached

    override suspend fun validAccessToken(): String? = withContext(Dispatchers.IO) {
        cached?.let { if (!expiringSoon(it)) return@withContext it }
        // Drop the AccountManager-cached token if ours is expiring, so the next
        // call re-hits the owner's authenticator instead of getting it back.
        cached?.let { manager.invalidateAuthToken(KubunoAccounts.TYPE, it) }
        fetch().also { cached = it }
    }

    override suspend fun refreshAfter401(failedAccessToken: String?): String? =
        withContext(Dispatchers.IO) {
            failedAccessToken?.let { manager.invalidateAuthToken(KubunoAccounts.TYPE, it) }
            cached = null
            fetch().also { cached = it }
        }

    /** Blocking, but always called off the main thread (IO dispatcher). */
    private fun fetch(): String? = runCatching {
        @Suppress("DEPRECATION") // notifyAuthFailure overload; no UI from here
        manager.blockingGetAuthToken(account, KubunoAccounts.AUTH_TOKEN_ACCESS, false)
    }.getOrNull()

    private fun expiringSoon(token: String): Boolean {
        val expSec = Jwt.expiresAtSeconds(token) ?: return true
        return expSec * 1000 - System.currentTimeMillis() < EXPIRY_MARGIN_MS
    }

    private companion object {
        const val EXPIRY_MARGIN_MS = 60_000L
    }
}
