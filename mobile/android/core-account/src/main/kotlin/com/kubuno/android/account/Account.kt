package com.kubuno.android.account

import kotlinx.serialization.Serializable

/**
 * Opaque, immutable handle for one signed-in account.
 *
 * Deliberately not derived from the server URL or the user name: both can
 * change (an instance moves domain, a user is renamed) and this id keys the
 * database file, the on-disk folders, the WorkManager job names and the cache
 * entries. It is minted once, at sign-in, and never rewritten.
 */
@JvmInline
@Serializable
value class AccountId(val value: String) {
    override fun toString(): String = value
}

/**
 * Everything non-secret about an account. Tokens never live here - they stay
 * in the per-account encrypted store.
 *
 * [serverUrl] is normalised without a trailing slash, and together with
 * [userId] it identifies the account on the network; the pair is what we
 * de-duplicate on, matching the web's own rule.
 */
@Serializable
data class AccountRecord(
    val id: AccountId,
    val serverUrl: String,
    val userId: String,
    val email: String? = null,
    val displayName: String? = null,
    /** Server-relative avatar path, as returned by the API. */
    val avatarPath: String? = null,
    val addedAtMs: Long = 0,
) {
    /** What the account switcher shows, and what AccountManager names it. */
    val label: String get() = displayName ?: email ?: userId

    /** Host alone, to tell two accounts of different instances apart. */
    val host: String
        get() = serverUrl.removePrefix("https://").removePrefix("http://").substringBefore('/')

    fun absolute(path: String?): String? = when {
        path == null -> null
        path.startsWith("http") -> path
        else -> serverUrl.trimEnd('/') + path
    }
}
