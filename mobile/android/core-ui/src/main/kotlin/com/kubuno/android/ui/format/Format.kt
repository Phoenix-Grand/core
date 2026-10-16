package com.kubuno.android.ui.format

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Size formatting mirrors the web (drive/frontend/src/api/format.ts): base 1024,
 * one decimal for KB/MB, two for GB, none for bytes. Units are localized -
 * French uses o/Ko/Mo/Go, not B/KB/MB/GB.
 */
fun formatSize(bytes: Long, units: SizeUnits): String = when {
    bytes < 1024 -> "$bytes ${units.byte}"
    bytes < 1_048_576 -> String.format(Locale.getDefault(), "%.1f %s", bytes / 1024.0, units.kb)
    bytes < 1_073_741_824 -> String.format(Locale.getDefault(), "%.1f %s", bytes / 1_048_576.0, units.mb)
    else -> String.format(Locale.getDefault(), "%.2f %s", bytes / 1_073_741_824.0, units.gb)
}

data class SizeUnits(val byte: String, val kb: String, val mb: String, val gb: String)

private val dateFormatter: DateTimeFormatter =
    DateTimeFormatter.ofPattern("dd MMM yyyy")

/**
 * Server timestamps are ISO-8601 UTC. The web drops dates at or before 1971 -
 * that value is the "no date" sentinel, not a real modification time.
 */
fun formatModified(isoTimestamp: String?): String? {
    if (isoTimestamp == null || isoTimestamp <= "1971") return null
    return runCatching {
        Instant.parse(isoTimestamp)
            .atZone(ZoneId.systemDefault())
            .format(dateFormatter.withLocale(Locale.getDefault()))
    }.getOrNull()
}
