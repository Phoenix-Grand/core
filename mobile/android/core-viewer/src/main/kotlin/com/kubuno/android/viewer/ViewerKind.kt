package com.kubuno.android.viewer

/**
 * File-type detection ported verbatim from the web (drive/frontend/src/
 * externalPreview.ts `previewKind` + FilesTextViewer `isTextFile`).
 *
 * The rule is: normalise a generic/missing MIME from the extension, then decide
 * by MIME first and extension as a fallback. Keeping it identical to the web
 * means the same files preview (or don't) in both places.
 */
enum class ViewerKind { IMAGE, PDF, TEXT, VIDEO, AUDIO, UNSUPPORTED }

/** MIME types too generic to trust - fall back to the extension for these. */
private val GENERIC_MIMES = setOf(
    "", "application/octet-stream", "binary/octet-stream",
    "application/binary", "application/unknown", "content/unknown",
)

/** extension → canonical MIME (the web's EXT_MIME table). */
private val EXT_MIME: Map<String, String> = buildMap {
    put("pdf", "application/pdf")
    for (e in listOf("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic", "tif", "tiff"))
        put(e, "image/*")
    for (e in listOf("mp4", "webm", "ogv", "mov", "mkv", "avi", "m4v"))
        put(e, "video/*")
    for (e in listOf("mp3", "ogg", "oga", "wav", "flac", "m4a", "aac", "opus"))
        put(e, "audio/*")
}

/**
 * Text file extensions (~120, the web's TEXT_EXTS), plus extensionless names
 * like Dockerfile/Makefile handled by [isTextFile].
 */
private val TEXT_EXTS = setOf(
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "json5", "jsonc", "xml", "yml", "yaml",
    "toml", "ini", "conf", "cfg", "env", "properties", "html", "htm", "css", "scss", "sass", "less",
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro",
    "py", "rb", "php", "go", "rs", "java", "kt", "kts", "scala", "swift", "c", "h", "cc", "cpp", "cxx",
    "hpp", "hh", "cs", "m", "mm", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "sql", "graphql", "gql", "proto", "dockerfile", "makefile", "cmake", "gradle", "groovy",
    "r", "lua", "pl", "pm", "dart", "ex", "exs", "erl", "hs", "clj", "cljs", "elm", "nim", "zig",
    "diff", "patch", "gitignore", "gitattributes", "editorconfig", "ics", "vcf", "srt", "vtt",
)

private val TEXT_MIMES = setOf(
    "application/json", "application/xml", "application/javascript",
    "application/x-yaml", "application/x-sh", "application/x-httpd-php",
)

private val TEXT_NAMES = setOf("dockerfile", "makefile", "cmakelists.txt", "license", "readme")

private fun extensionOf(name: String): String =
    name.substringAfterLast('.', "").lowercase().takeIf { it != name.lowercase() } ?: ""

private fun isTextFile(name: String, mime: String): Boolean {
    if (mime.startsWith("text/")) return true
    if (mime in TEXT_MIMES) return true
    val ext = extensionOf(name)
    if (ext.isNotEmpty() && ext in TEXT_EXTS) return true
    return name.lowercase() in TEXT_NAMES
}

/** Canonical MIME: the given one, or the extension's when it is too generic. */
private fun guessMime(name: String, mime: String?): String {
    val given = mime?.trim()?.lowercase().orEmpty()
    if (given.isNotEmpty() && given !in GENERIC_MIMES) return given
    return EXT_MIME[extensionOf(name)] ?: given
}

/** Which viewer renders this file, in the web's decision order. */
fun previewKind(name: String, mime: String?): ViewerKind {
    val m = guessMime(name, mime)
    return when {
        m == "application/pdf" -> ViewerKind.PDF
        m.startsWith("image/") -> ViewerKind.IMAGE
        m.startsWith("video/") -> ViewerKind.VIDEO
        m.startsWith("audio/") -> ViewerKind.AUDIO
        isTextFile(name, m) -> ViewerKind.TEXT
        else -> ViewerKind.UNSUPPORTED
    }
}

/** True when an in-app viewer exists - the delegation contract's `canPreview`. */
fun canPreview(name: String, mime: String?): Boolean =
    previewKind(name, mime) != ViewerKind.UNSUPPORTED
