package com.kubuno.android.api

import com.kubuno.android.api.model.DeclareDeviceRequest
import com.kubuno.android.api.model.LoginRequest
import com.kubuno.android.api.model.MeResponse
import com.kubuno.android.api.model.MyDevicesResponse
import com.kubuno.android.api.model.RefreshRequest
import com.kubuno.android.api.model.SessionResponse
import com.kubuno.android.api.model.SessionsResponse
import com.kubuno.android.api.model.TotpRequest
import okhttp3.MultipartBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.Part
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * Core auth + account surface. Endpoints return raw [Response] so the caller
 * (TokenManager) can classify HTTP statuses precisely (401 vs 429 vs 5xx).
 */
interface AuthApi {
    @POST("api/v1/auth/login")
    suspend fun login(@Body body: LoginRequest): Response<SessionResponse>

    @POST("api/v1/auth/totp")
    suspend fun verifyTotp(@Body body: TotpRequest): Response<SessionResponse>

    @POST("api/v1/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Response<SessionResponse>

    @POST("api/v1/auth/logout")
    suspend fun logout(@Body body: RefreshRequest): Response<Unit>

    /** Cheap reachability probe (also used by the desktop client). */
    @GET("healthz")
    suspend fun health(): Response<Unit>

    @GET("api/v1/me")
    suspend fun me(): Response<MeResponse>

    @POST("api/v1/me/devices/declare")
    suspend fun declareDevice(@Body body: DeclareDeviceRequest): Response<Unit>

    /** Live sessions of the account. No session is flagged as the current one. */
    @GET("api/v1/me/sessions")
    suspend fun sessions(): Response<SessionsResponse>

    /**
     * Same sessions, joined to the device inventory, plus `current_device_id`.
     * Preferred over [sessions] because it is the only way to tell the caller
     * which rows belong to this phone.
     */
    @GET("api/v1/me/devices")
    suspend fun myDevices(): Response<MyDevicesResponse>

    /**
     * Replaces the profile picture. The server stores what it receives without
     * resizing, so [avatar] must already be the square crop the user chose;
     * [original] is kept aside so a later re-crop can start from the full image.
     */
    @Multipart
    @POST("api/v1/me/avatar")
    suspend fun uploadAvatar(
        @Part avatar: MultipartBody.Part,
        @Part original: MultipartBody.Part?,
    ): Response<MeResponse>

    /** Revokes one session. 404 when the id is unknown or already revoked. */
    @DELETE("api/v1/me/sessions/{id}")
    suspend fun revokeSession(@Path("id") id: String): Response<Unit>

    /**
     * Revokes EVERY session of the account, this one included - the server has
     * no "all the others" variant. The caller must sign out locally afterwards.
     */
    @DELETE("api/v1/me/sessions")
    suspend fun revokeAllSessions(): Response<Unit>
}
