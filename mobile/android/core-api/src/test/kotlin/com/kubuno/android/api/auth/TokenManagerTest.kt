package com.kubuno.android.api.auth

import com.kubuno.android.api.AuthApi
import com.kubuno.android.api.model.DeclareDeviceRequest
import com.kubuno.android.api.model.LoginRequest
import com.kubuno.android.api.model.MeResponse
import com.kubuno.android.api.model.RefreshRequest
import com.kubuno.android.api.model.MyDevicesResponse
import com.kubuno.android.api.model.SessionResponse
import com.kubuno.android.api.model.SessionsResponse
import com.kubuno.android.api.model.TotpRequest
import java.io.IOException
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import retrofit2.Response

/** JWT with the given exp claim - unsigned, the client never verifies. */
private fun jwt(expEpochSeconds: Long): String {
    val enc = Base64.getUrlEncoder().withoutPadding()
    val header = enc.encodeToString("""{"alg":"HS256"}""".toByteArray())
    val payload = enc.encodeToString("""{"exp":$expEpochSeconds}""".toByteArray())
    return "$header.$payload.sig"
}

private class FakeStore(initial: StoredTokens? = null) : TokenStore {
    var tokens: StoredTokens? = initial
    var saveCount = 0
    override fun load(): StoredTokens? = tokens
    override fun save(tokens: StoredTokens) {
        saveCount++
        this.tokens = tokens
    }
    override fun clear() {
        tokens = null
    }
}

private class FakeApi(
    val onRefresh: suspend (RefreshRequest) -> Response<SessionResponse> = { error("unexpected refresh") },
) : AuthApi {
    val refreshCalls = AtomicInteger(0)
    override suspend fun login(body: LoginRequest): Response<SessionResponse> = error("unused")
    override suspend fun verifyTotp(body: TotpRequest): Response<SessionResponse> = error("unused")
    override suspend fun refresh(body: RefreshRequest): Response<SessionResponse> {
        refreshCalls.incrementAndGet()
        return onRefresh(body)
    }
    override suspend fun logout(body: RefreshRequest): Response<Unit> = Response.success(Unit)
    override suspend fun health(): Response<Unit> = Response.success(Unit)
    override suspend fun me(): Response<MeResponse> = error("unused")
    override suspend fun declareDevice(body: DeclareDeviceRequest): Response<Unit> = error("unused")
    // Account-screen surface: irrelevant to the refresh state machine.
    override suspend fun sessions(): Response<SessionsResponse> = error("unused")
    override suspend fun myDevices(): Response<MyDevicesResponse> = error("unused")
    override suspend fun revokeSession(id: String): Response<Unit> = error("unused")
    override suspend fun revokeAllSessions(): Response<Unit> = error("unused")
    override suspend fun uploadAvatar(
        avatar: MultipartBody.Part,
        original: MultipartBody.Part?,
    ): Response<MeResponse> = error("unused")
}

private fun ok(access: String, refresh: String): Response<SessionResponse> =
    Response.success(SessionResponse(accessToken = access, refreshToken = refresh))

private fun httpError(code: Int): Response<SessionResponse> =
    Response.error(code, "{}".toResponseBody("application/json".toMediaType()))

private const val HOUR_S = 3600L

class TokenManagerTest {
    private var nowMs = 1_000_000_000_000L
    private val clock: () -> Long = { nowMs }
    private fun nowS() = nowMs / 1000

    @Test
    fun `valid access token is returned without any network call`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() + HOUR_S), "r1", nowMs))
        val api = FakeApi()
        val tm = TokenManager(api, store, clock)
        assertEquals(store.tokens!!.accessToken, tm.validAccessToken())
        assertEquals(0, api.refreshCalls.get())
    }

    @Test
    fun `expired access triggers refresh and new pair is persisted before return`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() - 10), "r1", nowMs - TokenManager.FRESH_TTL_MS - 1))
        val newAccess = jwt(nowS() + HOUR_S)
        val api = FakeApi(onRefresh = { req ->
            assertEquals("r1", req.refreshToken)
            ok(newAccess, "r2")
        })
        val tm = TokenManager(api, store, clock)
        assertEquals(newAccess, tm.validAccessToken())
        assertEquals(1, api.refreshCalls.get())
        assertEquals("r2", store.tokens!!.refreshToken) // persisted
    }

    @Test
    fun `concurrent refreshes are single-flight`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() - 10), "r1", nowMs - TokenManager.FRESH_TTL_MS - 1))
        val newAccess = jwt(nowS() + HOUR_S)
        val api = FakeApi(onRefresh = {
            delay(150) // both callers must pile up on the mutex
            ok(newAccess, "r2")
        })
        val tm = TokenManager(api, store, clock)
        val a = async(Dispatchers.Default) { tm.validAccessToken() }
        val b = async(Dispatchers.Default) { tm.validAccessToken() }
        assertEquals(newAccess, a.await())
        assertEquals(newAccess, b.await())
        assertEquals(1, api.refreshCalls.get())
    }

    @Test
    fun `pair rotated less than 5 minutes ago is adopted, not rotated again`() = runBlocking {
        // Access expired but the pair is "fresh": still no rotation on the
        // second concurrent path - the store re-read adopts it. Here we check
        // the direct path: fresh + usable access short-circuits.
        val access = jwt(nowS() + HOUR_S)
        val store = FakeStore(StoredTokens(access, "r1", nowMs - 60_000)) // rotated 1 min ago
        val api = FakeApi()
        val tm = TokenManager(api, store, clock)
        assertEquals(access, tm.validAccessToken())
        assertEquals(0, api.refreshCalls.get())
    }

    @Test
    fun `transient failure keeps the refresh token and arms the cooldown`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() - 10), "r1", nowMs - TokenManager.FRESH_TTL_MS - 1))
        val api = FakeApi(onRefresh = { throw IOException("network down") })
        val tm = TokenManager(api, store, clock)

        try {
            tm.validAccessToken()
            fail("expected AuthException")
        } catch (e: AuthException) {
            assertEquals(FailureKind.TRANSIENT, e.kind)
        }
        assertEquals("r1", store.tokens!!.refreshToken) // token kept

        // Second attempt inside the cooldown: no API call at all.
        try {
            tm.validAccessToken()
            fail("expected AuthException")
        } catch (e: AuthException) {
            assertEquals(FailureKind.TRANSIENT, e.kind)
        }
        assertEquals(1, api.refreshCalls.get())

        // After the cooldown the API is tried again.
        nowMs += TokenManager.REFRESH_COOLDOWN_MS + 1
        try {
            tm.validAccessToken()
            fail("expected AuthException")
        } catch (e: AuthException) {
            assertEquals(FailureKind.TRANSIENT, e.kind)
        }
        assertEquals(2, api.refreshCalls.get())
    }

    @Test
    fun `429 is transient`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() - 10), "r1", nowMs - TokenManager.FRESH_TTL_MS - 1))
        val api = FakeApi(onRefresh = { httpError(429) })
        val tm = TokenManager(api, store, clock)
        try {
            tm.validAccessToken()
            fail("expected AuthException")
        } catch (e: AuthException) {
            assertEquals(FailureKind.TRANSIENT, e.kind)
        }
        assertEquals("r1", store.tokens!!.refreshToken)
    }

    @Test
    fun `401 on refresh is genuine - session wiped and state expired`() = runBlocking {
        val store = FakeStore(StoredTokens(jwt(nowS() - 10), "r1", nowMs - TokenManager.FRESH_TTL_MS - 1))
        val api = FakeApi(onRefresh = { httpError(401) })
        val tm = TokenManager(api, store, clock)
        try {
            tm.validAccessToken()
            fail("expected AuthException")
        } catch (e: AuthException) {
            assertEquals(FailureKind.GENUINE, e.kind)
        }
        assertNull(store.tokens)
        assertTrue(tm.authState.value is AuthState.Expired)
    }

    @Test
    fun `refreshAfter401 adopts a token another caller already rotated`() = runBlocking {
        val usable = jwt(nowS() + HOUR_S)
        val store = FakeStore(StoredTokens(usable, "r2", nowMs))
        val api = FakeApi()
        val tm = TokenManager(api, store, clock)
        // The failed request carried an older token - the cached one is newer.
        assertEquals(usable, tm.refreshAfter401("some-older-token"))
        assertEquals(0, api.refreshCalls.get())
    }

    @Test
    fun `refreshAfter401 with the current token forces a rotation despite freshness`() = runBlocking {
        val current = jwt(nowS() + HOUR_S)
        val newAccess = jwt(nowS() + 2 * HOUR_S)
        val store = FakeStore(StoredTokens(current, "r1", nowMs)) // fresh pair
        val api = FakeApi(onRefresh = { ok(newAccess, "r2") })
        val tm = TokenManager(api, store, clock)
        assertEquals(newAccess, tm.refreshAfter401(current))
        assertEquals(1, api.refreshCalls.get())
        assertEquals("r2", store.tokens!!.refreshToken)
    }

    @Test
    fun `no session returns null without network`() = runBlocking {
        val tm = TokenManager(FakeApi(), FakeStore(null), clock)
        assertNull(tm.validAccessToken())
    }
}
