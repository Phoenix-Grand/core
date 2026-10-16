package com.kubuno.android.api.auth

import com.kubuno.android.api.AuthApi
import com.kubuno.android.api.model.LoginRequest
import com.kubuno.android.api.model.RefreshRequest
import com.kubuno.android.api.model.SessionResponse
import com.kubuno.android.api.model.TotpRequest
import com.kubuno.android.api.model.UserDto
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.Response

sealed interface LoginOutcome {
    data class Success(val user: UserDto?) : LoginOutcome
    data class TotpRequired(val totpSession: String) : LoginOutcome
    data class Failure(val httpCode: Int?, val transient: Boolean) : LoginOutcome
}

/**
 * Owns the session token pair and the refresh state machine.
 *
 * This is a direct port of the hard-won behaviour of the desktop engine
 * (desktop/crates/kubuno-sync/src/api.rs):
 *  - single-flight: refreshes are serialized behind a [Mutex]; concurrent
 *    rotations brick the session family server-side;
 *  - a pair rotated less than [FRESH_TTL_MS] ago is adopted, not rotated again
 *    (collapses the rotation storm at app start that trips the 60/min limit);
 *  - after a transient failure we hold a [REFRESH_COOLDOWN_MS] cooldown so a
 *    large work backlog cannot saturate the server's rate-limit window;
 *  - only 401/403 from /auth/refresh ends the session ([FailureKind.GENUINE]);
 *    429/5xx/network keep the refresh token ([FailureKind.TRANSIENT]);
 *  - the rotated pair is persisted via [TokenStore.save] BEFORE being used:
 *    replaying a rotated-away token triggers reuse_detected and the server's
 *    24h grace only applies while the successor has never served.
 */
class TokenManager(
    private val api: AuthApi,
    private val store: TokenStore,
    private val clock: () -> Long = System::currentTimeMillis,
) : BearerSource {
    companion object {
        const val FRESH_TTL_MS = 5 * 60 * 1000L
        const val REFRESH_COOLDOWN_MS = 45_000L

        /** Refresh proactively when the access token has less than this left. */
        const val EXPIRY_MARGIN_MS = 60_000L
    }

    private val mutex = Mutex()

    @Volatile private var cooldownUntilMs = 0L

    private val _authState = MutableStateFlow(
        when (store.load()) {
            null -> AuthState.LoggedOut
            else -> AuthState.LoggedIn(store.load()!!.accessToken)
        } as AuthState
    )
    val authState: StateFlow<AuthState> = _authState

    /** Last known pair; source of truth stays the [TokenStore]. */
    @Volatile private var cached: StoredTokens? = store.load()

    fun isLoggedIn(): Boolean = cached != null

    /** Access token currently held, without triggering any network activity. */
    override fun peekAccessToken(): String? = cached?.accessToken

    /**
     * Returns a valid access token, refreshing first when the current one is
     * expired or about to expire. Returns null when there is no session at all.
     * Throws [AuthException] (TRANSIENT while in cooldown / network down, or
     * GENUINE when the session is dead - state is then [AuthState.Expired]).
     */
    override suspend fun validAccessToken(): String? {
        val current = cached ?: store.load()?.also { cached = it } ?: return null
        if (isAccessUsable(current.accessToken)) return current.accessToken
        return refresh(forceEvenIfFresh = false).accessToken
    }

    /**
     * Called after a request came back 401 with [failedAccessToken]. Adopts the
     * pair another caller already rotated, otherwise forces a rotation (the
     * fresh-adopt shortcut must not return the very token that just failed).
     */
    override suspend fun refreshAfter401(failedAccessToken: String?): String {
        cached?.let { if (it.accessToken != failedAccessToken && isAccessUsable(it.accessToken)) return it.accessToken }
        return refresh(forceEvenIfFresh = true).accessToken
    }

    private suspend fun refresh(forceEvenIfFresh: Boolean): StoredTokens = mutex.withLock {
        // Re-read the store inside the lock: adopt a pair a concurrent caller
        // (or a previous process instance) just persisted.
        val current = store.load()?.also { cached = it }
            ?: run {
                markExpired("no stored session")
                throw AuthException(FailureKind.GENUINE, "No stored session")
            }

        val now = clock()
        val fresh = now - current.lastRefreshAtMs < FRESH_TTL_MS
        if (fresh && isAccessUsable(current.accessToken) && !forceEvenIfFresh) return current

        if (now < cooldownUntilMs) {
            throw AuthException(FailureKind.TRANSIENT, "Refresh cooldown active")
        }

        val response: Response<SessionResponse> = try {
            api.refresh(RefreshRequest(current.refreshToken))
        } catch (e: IOException) {
            cooldownUntilMs = clock() + REFRESH_COOLDOWN_MS
            throw AuthException(FailureKind.TRANSIENT, "Network failure during refresh", e)
        }

        if (response.isSuccessful) {
            val body = response.body()
            val access = body?.accessToken
            val refreshTok = body?.refreshToken
            if (access == null || refreshTok == null) {
                cooldownUntilMs = clock() + REFRESH_COOLDOWN_MS
                throw AuthException(FailureKind.TRANSIENT, "Malformed refresh response")
            }
            val rotated = StoredTokens(access, refreshTok, clock())
            // Persist FIRST - only then is the new pair allowed to serve.
            store.save(rotated)
            cached = rotated
            _authState.value = AuthState.LoggedIn(access)
            return rotated
        }

        when (response.code()) {
            401, 403 -> {
                store.clear()
                cached = null
                markExpired("refresh rejected (${response.code()})")
                throw AuthException(FailureKind.GENUINE, "Session expired or revoked")
            }
            else -> {
                cooldownUntilMs = clock() + REFRESH_COOLDOWN_MS
                throw AuthException(FailureKind.TRANSIENT, "Refresh failed (${response.code()})")
            }
        }
    }

    suspend fun login(login: String, password: String, deviceName: String?): LoginOutcome {
        val response = try {
            api.login(LoginRequest(login = login, password = password, deviceName = deviceName))
        } catch (e: IOException) {
            return LoginOutcome.Failure(httpCode = null, transient = true)
        }
        return handleSessionResponse(response)
    }

    suspend fun verifyTotp(code: String, totpSession: String): LoginOutcome {
        val response = try {
            api.verifyTotp(TotpRequest(code = code, totpSession = totpSession))
        } catch (e: IOException) {
            return LoginOutcome.Failure(httpCode = null, transient = true)
        }
        return handleSessionResponse(response)
    }

    private fun handleSessionResponse(response: Response<SessionResponse>): LoginOutcome {
        if (!response.isSuccessful) {
            return LoginOutcome.Failure(httpCode = response.code(), transient = response.code() >= 500)
        }
        val body = response.body() ?: return LoginOutcome.Failure(httpCode = null, transient = true)
        if (body.requiresTotp) {
            val session = body.totpSession
                ?: return LoginOutcome.Failure(httpCode = null, transient = false)
            return LoginOutcome.TotpRequired(session)
        }
        val access = body.accessToken
        val refreshTok = body.refreshToken
        if (access == null || refreshTok == null) {
            return LoginOutcome.Failure(httpCode = null, transient = false)
        }
        val tokens = StoredTokens(access, refreshTok, clock())
        store.save(tokens)
        cached = tokens
        cooldownUntilMs = 0L
        _authState.value = AuthState.LoggedIn(access)
        return LoginOutcome.Success(body.user)
    }

    /** Best-effort server-side revocation, then local wipe. Never throws. */
    suspend fun logout() {
        val refreshTok = cached?.refreshToken ?: store.load()?.refreshToken
        if (refreshTok != null) {
            runCatching { api.logout(RefreshRequest(refreshTok)) }
        }
        store.clear()
        cached = null
        _authState.value = AuthState.LoggedOut
    }

    private fun isAccessUsable(accessToken: String): Boolean {
        val exp = Jwt.expiresAtSeconds(accessToken) ?: return false
        return exp * 1000 - EXPIRY_MARGIN_MS > clock()
    }

    private fun markExpired(reason: String) {
        _authState.value = AuthState.Expired(reason)
    }
}
