package com.kubuno.android.api

import com.kubuno.android.api.model.CreateFolderRequest
import com.kubuno.android.api.model.DriveDeltaResponse
import com.kubuno.android.api.model.FileEnvelope
import com.kubuno.android.api.model.FolderEnvelope
import com.kubuno.android.api.model.MoveRequest
import com.kubuno.android.api.model.RenameRequest
import com.kubuno.android.api.model.UploadEnvelope
import com.kubuno.android.api.model.InitUploadRequest
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Multipart
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming

/**
 * Drive module surface (proxied by the core under /api/v1/drive).
 *
 * Every mutation takes an Idempotency-Key. The server caches the first 2xx for
 * 24h keyed by (user, method, path, key) and ignores the body on replay, so a
 * key must identify one logical operation - never reuse one for a new edit.
 */
interface DriveApi {
    /**
     * Cursor-based incremental sync. `cursor=0` yields the full snapshot;
     * page until `has_more` is false, persisting the cursor with each page.
     */
    @GET("api/v1/drive/sync/delta")
    suspend fun delta(
        @Query("cursor") cursor: Long,
        @Query("limit") limit: Int = 2000,
        @Query("full") full: Boolean = true,
    ): Response<DriveDeltaResponse>

    // ---- files ----------------------------------------------------------

    @PATCH("api/v1/drive/{id}/rename")
    suspend fun renameFile(
        @Path("id") id: String,
        @Body body: RenameRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    @PATCH("api/v1/drive/{id}/move")
    suspend fun moveFile(
        @Path("id") id: String,
        @Body body: MoveRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    @POST("api/v1/drive/{id}/trash")
    suspend fun trashFile(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    @POST("api/v1/drive/{id}/restore")
    suspend fun restoreFile(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    /** Pure toggle: no body, and there is no unstar endpoint. */
    @POST("api/v1/drive/{id}/star")
    suspend fun toggleFileStar(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    // ---- folders --------------------------------------------------------

    @POST("api/v1/drive/folders")
    suspend fun createFolder(
        @Body body: CreateFolderRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    @PATCH("api/v1/drive/folders/{id}/rename")
    suspend fun renameFolder(
        @Path("id") id: String,
        @Body body: RenameRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    @PATCH("api/v1/drive/folders/{id}/move")
    suspend fun moveFolder(
        @Path("id") id: String,
        @Body body: MoveRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    @POST("api/v1/drive/folders/{id}/trash")
    suspend fun trashFolder(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    @POST("api/v1/drive/folders/{id}/restore")
    suspend fun restoreFolder(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    @POST("api/v1/drive/folders/{id}/star")
    suspend fun toggleFolderStar(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FolderEnvelope>

    // ---- transfers ------------------------------------------------------

    @Multipart
    @POST("api/v1/drive/upload")
    suspend fun upload(
        @Part file: MultipartBody.Part,
        @Part("folder_id") folderId: RequestBody?,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    @POST("api/v1/drive/uploads")
    suspend fun initUpload(
        @Body body: InitUploadRequest,
        @Header("Idempotency-Key") key: String,
    ): Response<UploadEnvelope>

    @Multipart
    @POST("api/v1/drive/uploads/{sid}/chunks/{index}")
    suspend fun uploadChunk(
        @Path("sid") sessionId: String,
        @Path("index") index: Int,
        @Part chunk: MultipartBody.Part,
    ): Response<UploadEnvelope>

    @GET("api/v1/drive/uploads/{id}")
    suspend fun uploadSession(@Path("id") id: String): Response<UploadEnvelope>

    @POST("api/v1/drive/uploads/{id}/complete")
    suspend fun completeUpload(
        @Path("id") id: String,
        @Header("Idempotency-Key") key: String,
    ): Response<FileEnvelope>

    @POST("api/v1/drive/uploads/{id}/abort")
    suspend fun abortUpload(@Path("id") id: String): Response<Unit>

    @Streaming
    @GET("api/v1/drive/{id}/download")
    suspend fun download(@Path("id") id: String): Response<ResponseBody>
}
