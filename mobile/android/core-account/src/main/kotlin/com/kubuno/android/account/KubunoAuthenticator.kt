package com.kubuno.android.account

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.kubuno.android.account.R
import com.kubuno.android.api.auth.AuthException
import com.kubuno.android.api.auth.FailureKind
import kotlinx.coroutines.runBlocking

/**
 * Names shared with every other Kubuno app on the device.
 *
 * The account type is the contract: a sibling app (calendar, mail, notes…)
 * signed with the same certificate calls
 * `AccountManager.getAccountsByType(KubunoAccounts.TYPE)` and
 * `getAuthToken(account, KubunoAccounts.AUTH_TOKEN_ACCESS, …)` - no permission
 * and no user consent, because same-signature callers are trusted by the
 * platform (the consent screen only exists for foreign signatures).
 */
object KubunoAccounts {
    /** Must match `android:accountType` in res/xml/authenticator.xml. */
    const val TYPE = "com.kubuno"

    /** The only token type we hand out: a short-lived (15 min) access token. */
    const val AUTH_TOKEN_ACCESS = "kubuno.access"

    // User data written on the system account. All of it is NON-SECRET: it is
    // just enough for a sibling app to know which instance to talk to and as
    // whom. Tokens never go in here - see AccountManagerBridge.
    const val USER_DATA_ACCOUNT_ID = "account_id"
    const val USER_DATA_SERVER_URL = "server_url"
    const val USER_DATA_USER_ID = "user_id"
    const val USER_DATA_EMAIL = "email"
    const val USER_DATA_DISPLAY_NAME = "display_name"

    /**
     * Set on the intent handed back by [KubunoAuthenticator.addAccount]: tells
     * [MainActivity] to open onboarding in "add another account" mode.
     */
    const val EXTRA_ADD_ACCOUNT = "com.kubuno.android.extra.ADD_ACCOUNT"

    /** Account whose session must be re-established, as an [AccountId] value. */
    const val EXTRA_ACCOUNT_ID = "com.kubuno.android.extra.ACCOUNT_ID"
}

/**
 * Lets other Kubuno apps borrow this app's sessions - access tokens only.
 *
 * Two deliberate restrictions:
 *
 *  1. **The refresh token never leaves this app.** AccountManager's database is
 *     not encrypted at the application level, while our own store is (AES-GCM
 *     under a non-exportable Keystore key). So the system account carries no
 *     password (`addAccountExplicitly(…, null, …)`) and no `setAuthToken`
 *     cache; only the profile fields above.
 *
 *  2. **This process is the only one that ever rotates.** The server rotates
 *     the refresh token on every use and revokes the whole session family when
 *     an already-rotated token is replayed. `TokenManager`'s single-flight lock
 *     is in-process, so a second app holding a copy of the refresh token would
 *     sign the account out the first time both refreshed at once. Callers
 *     therefore get 15-minute access tokens through [getAuthToken], and this
 *     process serialises every refresh behind that same lock.
 */
class KubunoAuthenticator(
    private val context: Context,
    private val registry: AccountRegistry,
    private val clients: AccountClients,
) : AbstractAccountAuthenticator(context) {

    /**
     * Adding an account means signing in, which needs UI, so hand back an
     * intent instead of a result. The response is forwarded in the extras: the
     * activity reports the outcome on it so the caller's
     * `AccountManagerFuture` completes instead of hanging.
     */
    override fun addAccount(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
        authTokenType: String?,
        requiredFeatures: Array<String>?,
        options: Bundle?,
    ): Bundle = Bundle().apply {
        val intent = signInIntent(response).putExtra(KubunoAccounts.EXTRA_ADD_ACCOUNT, true)
        putParcelable(AccountManager.KEY_INTENT, intent)
    }

    /**
     * Returns a currently valid access token for [account], refreshing it here
     * if needed. Runs on a binder thread, so blocking is both allowed and
     * required - the caller is waiting on an `AccountManagerFuture`.
     */
    override fun getAuthToken(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle {
        if (account == null) return errorBundle(AccountManager.ERROR_CODE_BAD_ARGUMENTS, "No account")
        if (authTokenType != KubunoAccounts.AUTH_TOKEN_ACCESS) {
            return errorBundle(
                AccountManager.ERROR_CODE_BAD_ARGUMENTS,
                "Unsupported token type: $authTokenType",
            )
        }

        // The id written on the system account can be STALE: the app that
        // published it may since have had its data cleared and re-registered the
        // same (instance, user) under a fresh id, which AccountManagerBridge
        // deliberately does not overwrite when it re-adopts the entry. Falling
        // back to the identity finds our own live record in that case; without
        // it this process refuses to mint, every consumer app gets a re-login
        // intent, and the whole device looks signed out while the owner app
        // works fine.
        val id = resolveAccountId(account)?.takeIf { registry.get(it) != null }
            ?: localIdFor(account)
        // The system account outlived the Kubuno registration (app data
        // cleared, account forgotten), or it was published by another app whose
        // id we do not know: a sibling may still be able to serve it.
        val client = id?.let { clients.of(it) }
            ?: return borrowedOr(account, response, id)

        return try {
            val token = runBlocking { client.tokenManager.validAccessToken() }
                ?: return borrowedOr(account, response, id)
            tokenBundle(account, token)
        } catch (e: AuthException) {
            when (e.kind) {
                // Our own session is dead for good - but the account may still
                // be alive in a sibling app, so ask before sending the user to
                // a sign-in screen.
                FailureKind.GENUINE -> borrowedOr(account, response, id)
                // Offline, rate-limited or in refresh cooldown: the session is
                // intact, the caller should simply retry later.
                FailureKind.TRANSIENT -> errorBundle(
                    AccountManager.ERROR_CODE_NETWORK_ERROR,
                    e.message ?: "Temporary refresh failure",
                )
            }
        } catch (e: Exception) {
            errorBundle(AccountManager.ERROR_CODE_NETWORK_ERROR, e.message ?: "Refresh failed")
        }
    }

    /**
     * Last resort before asking the user to sign in again: any sibling Kubuno
     * app that still holds a live session for this account can lend a
     * short-lived access token. Only when none can is the account really
     * unusable.
     */
    private fun borrowedOr(
        account: Account,
        response: AccountAuthenticatorResponse?,
        id: AccountId?,
    ): Bundle {
        val manager = AccountManager.get(context)
        val serverUrl = manager.getUserData(account, KubunoAccounts.USER_DATA_SERVER_URL)
        val userId = manager.getUserData(account, KubunoAccounts.USER_DATA_USER_ID)
        if (!serverUrl.isNullOrEmpty() && !userId.isNullOrEmpty()) {
            KubunoTokenProvider.borrowFromSiblings(context, serverUrl, userId)?.let {
                return tokenBundle(account, it)
            }
        }
        return reLoginBundle(response, id)
    }

    private fun tokenBundle(account: Account, token: String) = Bundle().apply {
        putString(AccountManager.KEY_ACCOUNT_NAME, account.name)
        putString(AccountManager.KEY_ACCOUNT_TYPE, KubunoAccounts.TYPE)
        putString(AccountManager.KEY_AUTHTOKEN, token)
    }

    override fun getAuthTokenLabel(authTokenType: String?): String? =
        if (authTokenType == KubunoAccounts.AUTH_TOKEN_ACCESS) {
            context.getString(R.string.kubuno_account_label)
        } else {
            null
        }

    /** Re-authenticating is the same sign-in screen, scoped to one account. */
    override fun updateCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle = reLoginBundle(response, account?.let(::resolveAccountId))

    /**
     * There is nothing to confirm without asking the user for a password, and
     * we never prompt from a background caller. Returning null means "no
     * answer", which the framework passes on unchanged.
     */
    override fun confirmCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        options: Bundle?,
    ): Bundle? = null

    /** No account features are defined, so nothing can be claimed. */
    override fun hasFeatures(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        features: Array<String>?,
    ): Bundle = Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }

    /** No settings activity is exposed; accounts are managed inside the app. */
    override fun editProperties(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
    ): Bundle = throw UnsupportedOperationException("Kubuno accounts are edited in the app")

    private fun resolveAccountId(account: Account): AccountId? =
        AccountManager.get(context)
            .getUserData(account, KubunoAccounts.USER_DATA_ACCOUNT_ID)
            ?.takeIf { it.isNotEmpty() }
            ?.let(::AccountId)

    /**
     * Our own registration for the (instance, user) this system account stands
     * for, regardless of the id written on it. Identity is the stable key; the
     * id is private to whichever app minted it.
     */
    private fun localIdFor(account: Account): AccountId? {
        val manager = AccountManager.get(context)
        val serverUrl = manager.getUserData(account, KubunoAccounts.USER_DATA_SERVER_URL)
            ?.takeIf { it.isNotEmpty() } ?: return null
        val userId = manager.getUserData(account, KubunoAccounts.USER_DATA_USER_ID)
            ?.takeIf { it.isNotEmpty() } ?: return null
        return registry.accounts.value.firstOrNull { record ->
            record.userId == userId &&
                record.serverUrl.trimEnd('/').equals(serverUrl.trimEnd('/'), ignoreCase = true)
        }?.id
    }

    /**
     * Launches the sign-in UI of whichever app the framework bound this
     * authenticator into - its own launcher activity, not a hardcoded class,
     * so the shared module stays app-agnostic. The activity reads the
     * authenticator response from the extras and reports the outcome on it.
     */
    private fun signInIntent(response: AccountAuthenticatorResponse?): Intent =
        (context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(Intent.ACTION_MAIN))
            .putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, response)

    /** Tells the caller "I cannot do this silently, show this to the user". */
    private fun reLoginBundle(response: AccountAuthenticatorResponse?, id: AccountId?): Bundle =
        Bundle().apply {
            val intent = signInIntent(response)
            if (id != null) intent.putExtra(KubunoAccounts.EXTRA_ACCOUNT_ID, id.value)
            putParcelable(AccountManager.KEY_INTENT, intent)
        }

    private fun errorBundle(code: Int, message: String): Bundle = Bundle().apply {
        putInt(AccountManager.KEY_ERROR_CODE, code)
        putString(AccountManager.KEY_ERROR_MESSAGE, message)
    }
}
