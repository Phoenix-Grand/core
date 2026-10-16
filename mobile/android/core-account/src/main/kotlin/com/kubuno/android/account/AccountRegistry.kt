package com.kubuno.android.account

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * The list of accounts on this device and which one the UI is showing.
 *
 * "Active" only drives what the screens display: every account keeps syncing,
 * uploading and listening in the background, so switching is a view change,
 * not a lifecycle change.
 */
@Singleton
class AccountRegistry @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = context.getSharedPreferences("kubuno-accounts", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private val _accounts = MutableStateFlow(load())
    val accounts: StateFlow<List<AccountRecord>> = _accounts.asStateFlow()

    private val _activeId = MutableStateFlow(loadActive())
    val activeId: StateFlow<AccountId?> = _activeId.asStateFlow()

    val active: AccountRecord? get() = _accounts.value.firstOrNull { it.id == _activeId.value }

    fun get(id: AccountId): AccountRecord? = _accounts.value.firstOrNull { it.id == id }

    /**
     * Adds an account, or refreshes the one already registered for the same
     * (server, user) pair - signing in again must not create a duplicate, and
     * must keep the existing id so the local data stays attached.
     */
    fun upsert(
        serverUrl: String,
        userId: String,
        email: String?,
        displayName: String?,
        avatarPath: String?,
    ): AccountRecord {
        val normalised = serverUrl.trimEnd('/')
        val existing = _accounts.value.firstOrNull {
            it.serverUrl == normalised && it.userId == userId
        }
        val record = existing?.copy(
            email = email ?: existing.email,
            displayName = displayName ?: existing.displayName,
            avatarPath = avatarPath ?: existing.avatarPath,
        ) ?: AccountRecord(
            id = AccountId(UUID.randomUUID().toString()),
            serverUrl = normalised,
            userId = userId,
            email = email,
            displayName = displayName,
            avatarPath = avatarPath,
            addedAtMs = System.currentTimeMillis(),
        )
        _accounts.value = _accounts.value.filterNot { it.id == record.id } + record
        persist()
        if (_activeId.value == null) setActive(record.id)
        return record
    }

    /** Updates the cached profile after a /me refresh. */
    fun updateProfile(id: AccountId, displayName: String?, email: String?, avatarPath: String?) {
        val record = get(id) ?: return
        _accounts.value = _accounts.value.map {
            if (it.id == id) {
                it.copy(
                    displayName = displayName ?: it.displayName,
                    email = email ?: it.email,
                    avatarPath = avatarPath ?: it.avatarPath,
                )
            } else it
        }
        persist()
    }

    fun setActive(id: AccountId?) {
        _activeId.value = id
        prefs.edit().putString(KEY_ACTIVE, id?.value).apply()
    }

    /**
     * Forgets an account. The caller is responsible for tearing down its graph
     * and erasing its data - this only drops the registration.
     */
    fun remove(id: AccountId) {
        _accounts.value = _accounts.value.filterNot { it.id == id }
        persist()
        if (_activeId.value == id) setActive(_accounts.value.firstOrNull()?.id)
    }

    private fun persist() {
        prefs.edit()
            .putString(KEY_ACCOUNTS, json.encodeToString(SERIALIZER, _accounts.value))
            .apply()
    }

    private fun load(): List<AccountRecord> {
        val raw = prefs.getString(KEY_ACCOUNTS, null) ?: return emptyList()
        return runCatching { json.decodeFromString(SERIALIZER, raw) }.getOrDefault(emptyList())
    }

    private fun loadActive(): AccountId? =
        prefs.getString(KEY_ACTIVE, null)?.let { AccountId(it) }

    private companion object {
        const val KEY_ACCOUNTS = "accounts"
        const val KEY_ACTIVE = "active"
        val SERIALIZER = ListSerializer(AccountRecord.serializer())
    }
}
