package com.kubuno.android.api.auth

/** Result of an auth attempt as exposed to the UI layer. */
sealed interface AuthState {
    /** No stored session - onboarding required. */
    data object LoggedOut : AuthState

    /** A stored session exists and is believed valid. */
    data class LoggedIn(val accessToken: String) : AuthState

    /**
     * The session is over for good (401/403 on /auth/refresh - expired, revoked
     * or reuse_detected). The user must log in again.
     */
    data class Expired(val reason: String) : AuthState
}

/** Classification of a failed refresh, mirroring kubuno-sync's AuthFailure. */
enum class FailureKind {
    /** 401/403 from /auth/refresh: the session is genuinely dead, re-login required. */
    GENUINE,

    /** 429/5xx/network: keep the refresh token and retry later (cooldown applies). */
    TRANSIENT,
}

class AuthException(val kind: FailureKind, message: String, cause: Throwable? = null) :
    Exception(message, cause)
