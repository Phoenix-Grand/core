package com.kubuno.android.account

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.runBlocking

/**
 * Lends a short-lived access token to the sibling Kubuno apps.
 *
 * Android binds ONE authenticator per account type, so every app's
 * `getAuthToken` is answered by a single process - and that process can only
 * mint from its OWN refresh token, which never leaves it. When that one app's
 * session dies, the account is still registered but nothing can produce a
 * token, and every app wrongly reports an expired session.
 *
 * This provider closes that gap: any app that still holds a live session for
 * the same (instance, user) hands out an access token, and
 * [KubunoAuthenticator] asks around before giving up. Refresh tokens are never
 * exchanged - only the 15-minute access token - so no second process can ever
 * rotate a session and get the family revoked.
 *
 * Exported, but behind a signature-level permission: only apps carrying the
 * Kubuno signing certificate can call it.
 */
class KubunoTokenProvider : ContentProvider() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun registry(): AccountRegistry
        fun clients(): AccountClients
    }

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method != METHOD_TOKEN) return null
        val serverUrl = extras?.getString(KEY_SERVER_URL) ?: return null
        val userId = extras.getString(KEY_USER_ID) ?: return null
        val context = context ?: return null

        val deps = runCatching {
            EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        }.getOrNull() ?: return null

        // Only this app's OWN accounts: the record carries the id that keys our
        // encrypted session store.
        val record = deps.registry().accounts.value.firstOrNull {
            it.serverUrl.trimEnd('/').equals(serverUrl.trimEnd('/'), ignoreCase = true) &&
                it.userId == userId
        } ?: return null

        val client = deps.clients().of(record.id) ?: return null
        // Blocking is correct here: the caller is a binder thread waiting on us,
        // and TokenManager serialises refreshes behind its own lock.
        val token = runCatching { runBlocking { client.tokenManager.validAccessToken() } }
            .getOrNull() ?: return null

        return Bundle().apply { putString(KEY_ACCESS_TOKEN, token) }
    }

    // A call()-only provider: nothing is queryable as a table.
    override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<String>?): Int = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<String>?): Int = 0

    companion object {
        const val METHOD_TOKEN = "kubuno.accessToken"
        const val KEY_SERVER_URL = "server_url"
        const val KEY_USER_ID = "user_id"
        const val KEY_ACCESS_TOKEN = "access_token"

        /** Authority suffix; each app publishes it under its own applicationId. */
        const val AUTHORITY_SUFFIX = ".kubunotokens"

        /**
         * Asks every sibling Kubuno app for a valid access token for
         * ([serverUrl], [userId]), returning the first one offered. Null when no
         * installed app holds a live session for that account.
         */
        fun borrowFromSiblings(context: Context, serverUrl: String, userId: String): String? {
            val extras = Bundle().apply {
                putString(KEY_SERVER_URL, serverUrl)
                putString(KEY_USER_ID, userId)
            }
            for (pkg in KubunoSiblings.packages(context)) {
                val uri = Uri.parse("content://$pkg$AUTHORITY_SUFFIX")
                val answer = runCatching {
                    context.contentResolver.call(uri, METHOD_TOKEN, null, extras)
                }.getOrNull()
                answer?.getString(KEY_ACCESS_TOKEN)?.takeIf { it.isNotEmpty() }?.let { return it }
            }
            return null
        }
    }
}
