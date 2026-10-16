package com.kubuno.android.account

import android.accounts.AccountManager
import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** A Kubuno account discovered on the device, without any secret. */
data class SharedAccount(
    val systemName: String,
    val serverUrl: String,
    val userId: String,
    val email: String?,
    val displayName: String?,
) {
    val label: String get() = displayName ?: email ?: userId
    val host: String
        get() = serverUrl.removePrefix("https://").removePrefix("http://").substringBefore('/')
}

/**
 * Reads the Kubuno accounts registered on the device through the system
 * `AccountManager`.
 *
 * This is how a *consumer* app (mail, calendar…) discovers the accounts a
 * *sibling* app signed in - the per-app [AccountRegistry] is private storage,
 * whereas the `com.kubuno` accounts are shared. Tokens are never read here: an
 * access token is obtained separately through `getAuthToken`, which the owning
 * app's authenticator serves. Same-signature callers need no permission.
 */
@Singleton
class SharedAccounts @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val manager = AccountManager.get(context)

    /** The Kubuno accounts currently on the device. Empty if none. */
    fun list(): List<SharedAccount> =
        manager.getAccountsByType(KubunoAccounts.TYPE).mapNotNull { account ->
            val server = manager.getUserData(account, KubunoAccounts.USER_DATA_SERVER_URL)
            val userId = manager.getUserData(account, KubunoAccounts.USER_DATA_USER_ID)
            // An account with no server/user was written by an older schema and
            // can never be resolved; skip it rather than show a broken row.
            if (server.isNullOrEmpty() || userId.isNullOrEmpty()) return@mapNotNull null
            SharedAccount(
                systemName = account.name,
                serverUrl = server,
                userId = userId,
                email = manager.getUserData(account, KubunoAccounts.USER_DATA_EMAIL),
                displayName = manager.getUserData(account, KubunoAccounts.USER_DATA_DISPLAY_NAME),
            )
        }
}
