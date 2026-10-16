package com.kubuno.android.account

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Bundle
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Mirrors [AccountRegistry] into the system's `AccountManager`.
 *
 * The registry stays the source of truth - it is what this app reads and
 * writes. The system accounts exist only so that *other* Kubuno apps can
 * discover which accounts are signed in here and ask [KubunoAuthenticator] for
 * an access token. This is a one-way projection: nothing is ever read back
 * from AccountManager into the registry.
 *
 * Every method touches the AccountManager database and is therefore
 * `suspend` + [Dispatchers.IO]: none of it may run on the main thread.
 */
@Singleton
class AccountManagerBridge @Inject constructor(
    @ApplicationContext private val context: Context,
    private val registry: AccountRegistry,
) {
    private val manager: AccountManager = AccountManager.get(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Mirrors the registry from now on. Idempotent; call once from
     * `Application.onCreate`. The first emission of the flow does the initial
     * reconciliation, which also repairs whatever a crash left half-written.
     */
    fun install() {
        scope.launch {
            registry.accounts.collect {
                runCatching { sync() }
                    .onFailure { Log.w(TAG, "Could not mirror accounts", it) }
            }
        }
    }

    /**
     * Makes the system accounts match the registry: creates the missing ones,
     * refreshes the user data of the existing ones, and drops the ones the
     * user has forgotten in the app.
     *
     * Matching is done on the `account_id` user data, never on the display
     * name - a rename (new display name, instance moved domain) must not be
     * seen as "old account gone, new account appeared", which would make
     * sibling apps lose their binding.
     */
    suspend fun sync() = withContext(Dispatchers.IO) {
        val records = registry.accounts.value
        // Collapse any duplicates a previous build left behind before matching.
        val system = dedupeByIdentity(manager.getAccountsByType(KubunoAccounts.TYPE))

        // Additive only. This runs in EVERY Kubuno app, but a system account may
        // belong to a sibling app whose registry this process cannot see -
        // pruning "accounts not in my registry" would let a consumer app (an
        // empty registry) delete the accounts the owner created. Removal is
        // therefore explicit: an app drops an account through remove() when the
        // user signs out of it here, never as a side effect of mirroring.
        val byId = system.mapNotNull { account ->
            manager.getUserData(account, KubunoAccounts.USER_DATA_ACCOUNT_ID)
                ?.let { it to account }
        }.toMap()
        // An account is ONE (instance, user) pair, whichever app signed it in.
        // Every app mints its own AccountId for its private storage, so matching
        // on that alone made the second app believe the account was missing and
        // add a duplicate. Identity is the real key; the local id is not.
        val byIdentity = system.mapNotNull { account -> identityOf(account)?.let { it to account } }.toMap()

        val takenNames = system.mapTo(mutableSetOf()) { it.name }
        val siblings = siblingPackages()
        for (account in system) grantVisibility(account, siblings)
        for (record in records) {
            val mine = byId[record.id.value]
            if (mine != null) {
                writeUserData(mine, record, claimId = true)
                continue
            }
            // Same account, signed in from another app: adopt its entry. The
            // account_id already on it belongs to the app that created it and is
            // what the authenticator resolves, so it is left untouched.
            val shared = byIdentity[identityKey(record.serverUrl, record.userId)]
            if (shared != null) {
                writeUserData(shared, record, claimId = false)
                continue
            }
            val name = uniqueName(record, takenNames)
            val account = Account(name, KubunoAccounts.TYPE)
            // Password is null on purpose. AccountManager stores it in a plain
            // (unencrypted at the app level) system database, while our own
            // session store is AES-GCM under a non-exportable Keystore key.
            // The refresh token would be the only thing worth putting there,
            // and it must never leave this app - sharing it would let a second
            // process rotate concurrently and get the whole session family
            // revoked. Sibling apps get access tokens through getAuthToken().
            //
            // Any Kubuno app may do this: the platform allows it for callers
            // signed with the authenticator's certificate, so whichever app the
            // user signs in from is the one that publishes the account.
            val added = runCatching {
                manager.addAccountExplicitly(account, null, userData(record))
            }.onFailure {
                Log.w(TAG, "Could not add system account", it)
            }.getOrDefault(false)
            if (added) {
                takenNames += name
                grantVisibility(account, siblings)
            }
        }
    }

    /**
     * Removes the extra system entries left when two apps each published the
     * same (instance, user). The survivor is the one with the plain name - the
     * first ever created; the later ones carry a `#<id>` suffix from
     * [uniqueName]. Only genuine duplicates are touched, so a real second
     * account is never collapsed into the first.
     */
    private fun dedupeByIdentity(accounts: Array<Account>): List<Account> {
        val groups = accounts.groupBy { identityOf(it) }
        val kept = mutableListOf<Account>()
        for ((identity, group) in groups) {
            if (identity == null || group.size == 1) {
                kept += group
                continue
            }
            val survivor = group.minByOrNull { it.name.length } ?: group.first()
            kept += survivor
            group.filter { it != survivor }.forEach { extra ->
                runCatching { manager.removeAccountExplicitly(extra) }
                    .onSuccess { Log.i(TAG, "Removed duplicate system account ${extra.name}") }
                    .onFailure { Log.w(TAG, "Could not remove duplicate account", it) }
            }
        }
        return kept
    }

    /** The (instance, user) pair a system account stands for, or null if unusable. */
    private fun identityOf(account: Account): String? {
        val server = manager.getUserData(account, KubunoAccounts.USER_DATA_SERVER_URL)
        val user = manager.getUserData(account, KubunoAccounts.USER_DATA_USER_ID)
        return if (server.isNullOrEmpty() || user.isNullOrEmpty()) null else identityKey(server, user)
    }

    private fun identityKey(serverUrl: String, userId: String): String =
        "${serverUrl.trimEnd('/')}|$userId"

    /**
     * Makes [account] readable by the other Kubuno apps.
     *
     * Since Android O an account is invisible to an app unless it owns the
     * authenticator or is granted visibility - and the same-signature default
     * stops applying once a second app declares the same authenticator, which
     * is exactly our case. So the owner grants visibility explicitly, gated on
     * a shared signing certificate: only genuine Kubuno apps, never a package
     * that merely guessed the "com.kubuno" type.
     */
    private fun grantVisibility(account: Account, siblingPackages: List<String>) {
        for (pkg in siblingPackages) {
            runCatching {
                manager.setAccountVisibility(account, pkg, AccountManager.VISIBILITY_VISIBLE)
            }.onFailure { Log.w(TAG, "Could not grant visibility to $pkg", it) }
        }
    }

    /** Installed packages, other than us, signed with our certificate. */
    private fun siblingPackages(): List<String> = KubunoSiblings.packages(context)

    /**
     * Name the system knows [id] by, once [sync] has run. Used to answer an
     * `AccountManagerFuture` with the account that was just added.
     */
    suspend fun systemName(id: AccountId): String? = withContext(Dispatchers.IO) {
        val accounts = manager.getAccountsByType(KubunoAccounts.TYPE)
        accounts.firstOrNull { manager.getUserData(it, KubunoAccounts.USER_DATA_ACCOUNT_ID) == id.value }?.name
            // Adopted entry: it was published by a sibling app, so it carries
            // that app's account_id - find it by identity instead.
            ?: registry.get(id)?.let { record ->
                val key = identityKey(record.serverUrl, record.userId)
                accounts.firstOrNull { identityOf(it) == key }?.name
            }
    }

    /** Drops the system account mirroring [record], if it is still there. */
    suspend fun remove(record: AccountRecord) = withContext(Dispatchers.IO) {
        manager.getAccountsByType(KubunoAccounts.TYPE)
            .filter { manager.getUserData(it, KubunoAccounts.USER_DATA_ACCOUNT_ID) == record.id.value }
            .forEach { account ->
                runCatching { manager.removeAccountExplicitly(account) }
                    .onFailure { Log.w(TAG, "Could not remove system account", it) }
            }
    }

    private fun userData(record: AccountRecord) = Bundle().apply {
        putString(KubunoAccounts.USER_DATA_ACCOUNT_ID, record.id.value)
        putString(KubunoAccounts.USER_DATA_SERVER_URL, record.serverUrl)
        putString(KubunoAccounts.USER_DATA_USER_ID, record.userId)
        putString(KubunoAccounts.USER_DATA_EMAIL, record.email)
        putString(KubunoAccounts.USER_DATA_DISPLAY_NAME, record.displayName)
    }

    /**
     * Refreshes the non-secret profile fields. [claimId] is false when adopting
     * an entry another app published: its `account_id` points at that app's
     * registry and token store, which is what the authenticator resolves, so
     * overwriting it would cut the account off from the session serving it.
     */
    private fun writeUserData(account: Account, record: AccountRecord, claimId: Boolean) {
        val data = userData(record)
        for (key in data.keySet()) {
            if (!claimId && key == KubunoAccounts.USER_DATA_ACCOUNT_ID) continue
            val value = data.getString(key)
            if (manager.getUserData(account, key) != value) {
                runCatching { manager.setUserData(account, key, value) }
                    .onFailure { Log.w(TAG, "Could not update user data $key", it) }
            }
        }
    }

    /**
     * Account names must be unique within a type, and "label (host)" is not
     * guaranteed to be: two accounts on the same instance can share a display
     * name. Fall back to a short slice of the (unique) account id.
     */
    private fun uniqueName(record: AccountRecord, taken: Set<String>): String {
        val base = "${record.label} (${record.host})"
        if (base !in taken) return base
        return "$base #${record.id.value.take(8)}"
    }

    private companion object {
        const val TAG = "AccountManagerBridge"
    }
}
