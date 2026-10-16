package com.kubuno.android.account

import android.content.Context
import com.kubuno.android.api.KubunoClient
import com.kubuno.android.api.SharedHttp
import com.kubuno.android.api.auth.TokenStore
import com.kubuno.android.data.AppPrefs
import com.kubuno.android.secure.AccountTokenStore
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * One authenticated HTTP client per account, for whichever Kubuno app is
 * running.
 *
 * This is the piece every app needs and none should re-implement: the session
 * lives in an encrypted per-account file, and a single [KubunoClient] instance
 * per account keeps every refresh behind one `TokenManager` lock - the server
 * revokes the whole session family if two refreshes race.
 *
 * What an app builds *on top* of a client (a database, a sync engine) is its
 * own business and stays in the app.
 */
@Singleton
class AccountClients @Inject constructor(
    @ApplicationContext private val context: Context,
    private val registry: AccountRegistry,
    private val appPrefs: AppPrefs,
) {
    private val shared = SharedHttp()
    private val clients = ConcurrentHashMap<String, KubunoClient>()

    fun store(id: AccountId): TokenStore = AccountTokenStore(context, id)

    /** Null when the account is not registered (or no longer is). */
    fun of(id: AccountId): KubunoClient? {
        clients[id.value]?.let { return it }
        val record = registry.get(id) ?: return null
        return clients.computeIfAbsent(id.value) { build(record.serverUrl, id) }
    }

    fun active(): KubunoClient? = registry.activeId.value?.let(::of)

    /**
     * Throwaway client bound to the URL being signed into. Kept out of the
     * cache on purpose: a typed-in address must never re-point an account
     * already in use.
     */
    fun probe(baseUrl: String, id: AccountId): KubunoClient = build(baseUrl, id)

    /** Drops the client and the session; the caller erases its own data. */
    fun forget(id: AccountId) {
        clients.remove(id.value)?.shutdown()
        File(context.filesDir, "sessions/${id.value}.bin").delete()
    }

    private fun build(baseUrl: String, id: AccountId) = KubunoClient(
        baseUrl = baseUrl,
        tokenStore = store(id),
        deviceKeyProvider = { appPrefs.deviceKey },
        shared = shared,
    )
}
