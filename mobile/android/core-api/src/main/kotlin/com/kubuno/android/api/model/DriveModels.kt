package com.kubuno.android.api.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Response of GET /api/v1/drive/sync/delta. */
@Serializable
data class DriveDeltaResponse(
    val changes: List<DriveChange> = emptyList(),
    val cursor: Long,
    @SerialName("has_more") val hasMore: Boolean = false,
)

/**
 * One change from the delta feed, ordered by the monotonic [changeSeq].
 * [kind] discriminates: "file" | "folder" | "deleted". With `full=true` the
 * complete model rides along in [file] / [folder].
 */
@Serializable
data class DriveChange(
    val kind: String,
    val id: String,
    @SerialName("change_seq") val changeSeq: Long,

    // kind = file | folder
    val name: String? = null,
    val trashed: Boolean = false,

    // kind = file
    @SerialName("folder_id") val folderId: String? = null,
    val etag: String? = null,
    val size: Long? = null,
    @SerialName("mime_type") val mimeType: String? = null,

    // kind = folder
    @SerialName("parent_id") val parentId: String? = null,
    val path: String? = null,

    // kind = deleted
    val target: String? = null,
    @SerialName("deleted_at") val deletedAt: String? = null,

    // full=true payloads
    val file: DriveFileDto? = null,
    val folder: DriveFolderDto? = null,
)

/** Full file model (subset we consume - byte-compatible with GET /api/v1/drive). */
@Serializable
data class DriveFileDto(
    val id: String,
    @SerialName("folder_id") val folderId: String? = null,
    val name: String,
    @SerialName("mime_type") val mimeType: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("content_hash") val contentHash: String? = null,
    @SerialName("is_starred") val isStarred: Boolean = false,
    @SerialName("is_trashed") val isTrashed: Boolean = false,
    @SerialName("has_thumbnail") val hasThumbnail: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

// ---- write surface -----------------------------------------------------

/** Envelopes: every drive mutation answers {"file": …} or {"folder": …}. */
@Serializable
data class FileEnvelope(val file: DriveFileDto)

@Serializable
data class FolderEnvelope(val folder: DriveFolderDto)

@Serializable
data class UploadEnvelope(val upload: UploadSessionDto)

/**
 * `strict` makes a name clash a 409 instead of a silent "(2)" rename. We leave
 * it false to match the web, so callers must read the name back from the
 * response - the server may have renamed the item.
 */
@Serializable
data class RenameRequest(
    val name: String,
    val overwrite: Boolean = false,
    val strict: Boolean = false,
)

/** Files use `folder_id`, folders use `parent_id`; null means the drive root. */
@Serializable
data class MoveRequest(
    @SerialName("folder_id") val folderId: String? = null,
    @SerialName("parent_id") val parentId: String? = null,
    val overwrite: Boolean = false,
    val strict: Boolean = false,
)

/**
 * The server honours a client-supplied [id], which lets an offline-created
 * folder keep the same identity once it reaches the server.
 */
@Serializable
data class CreateFolderRequest(
    val name: String,
    @SerialName("parent_id") val parentId: String? = null,
    val id: String? = null,
)

@Serializable
data class InitUploadRequest(
    val filename: String,
    @SerialName("total_size") val totalSize: Long,
    @SerialName("chunk_size") val chunkSize: Long,
    @SerialName("folder_id") val folderId: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    val overwrite: Boolean = false,
)

/**
 * Resumable upload session. [chunksReceived] is a plain counter - the server
 * exposes no per-index bitmap and increments it on every accepted chunk, even
 * a duplicate, so the client must track which indices it has acknowledged.
 */
@Serializable
data class UploadSessionDto(
    val id: String,
    val filename: String,
    @SerialName("total_size") val totalSize: Long,
    @SerialName("chunk_size") val chunkSize: Long,
    @SerialName("total_chunks") val totalChunks: Int,
    @SerialName("chunks_received") val chunksReceived: Int,
    val status: String,
    val error: String? = null,
    @SerialName("file_id") val fileId: String? = null,
)

/** Full folder model (subset we consume). */
@Serializable
data class DriveFolderDto(
    val id: String,
    @SerialName("parent_id") val parentId: String? = null,
    val name: String,
    val path: String,
    @SerialName("is_starred") val isStarred: Boolean = false,
    @SerialName("is_trashed") val isTrashed: Boolean = false,
    val color: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)
