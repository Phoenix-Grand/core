package com.kubuno.android.viewer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.WrapText
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FileDownload
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * One file to view: its metadata, plus - for video/audio - a [streamUrl] the
 * player can stream from over the app's authenticated client, avoiding a full
 * download. Other kinds are fetched to a file on demand.
 */
data class ViewerItem(
    val name: String,
    val mime: String?,
    val size: Long = 0,
    val streamUrl: String? = null,
)

/**
 * The shared file-viewer surface - the Android equivalent of the web's
 * `openPreview(items, index)` delegation contract. Mail opens an attachment
 * here, drive will preview a file here; the same viewers render both.
 *
 * [fetch] downloads item `index` to a local file (the app owns the
 * authenticated transfer); the host then picks the viewer by [previewKind].
 * A gallery of items is swipeable. Unsupported types offer download / open-with
 * rather than a broken preview, matching the web.
 *
 * Rendered as a full-screen dark dialog, so it overlays whatever screen invoked
 * it without needing a navigation graph.
 */
@Composable
fun FileViewer(
    items: List<ViewerItem>,
    initialIndex: Int,
    fetch: suspend (Int) -> File,
    onDownload: (Int) -> Unit,
    onOpenExternally: (Int) -> Unit,
    onClose: () -> Unit,
    mediaHttpClient: okhttp3.OkHttpClient? = null,
) {
    if (items.isEmpty()) { onClose(); return }
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        val pager = rememberPagerState(initialPage = initialIndex.coerceIn(0, items.lastIndex)) { items.size }
        var wrap by remember { mutableStateOf(true) }

        Box(Modifier.fillMaxSize().background(OverlayBg)) {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                ViewerPage(
                    item = items[page],
                    fetch = { fetch(page) },
                    wrap = wrap,
                    mediaHttpClient = mediaHttpClient,
                    onOpenExternally = { onOpenExternally(page) },
                    onDownload = { onDownload(page) },
                )
            }

            // Top bar: name, gallery position, and the per-type actions.
            val current = items[pager.currentPage]
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BarIcon(Icons.Outlined.Close, stringResource(R.string.viewer_close), onClose)
                Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                    Text(
                        current.name,
                        color = Color.White,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (items.size > 1) {
                        Text(
                            "${pager.currentPage + 1} / ${items.size}",
                            color = Color.White.copy(alpha = 0.6f),
                            fontSize = 12.sp,
                        )
                    }
                }
                if (previewKind(current.name, current.mime) == ViewerKind.TEXT) {
                    BarIcon(Icons.AutoMirrored.Outlined.WrapText, stringResource(R.string.viewer_wrap)) { wrap = !wrap }
                }
                BarIcon(Icons.Outlined.OpenInNew, stringResource(R.string.viewer_open_with)) { onOpenExternally(pager.currentPage) }
                BarIcon(Icons.Outlined.FileDownload, stringResource(R.string.viewer_download)) { onDownload(pager.currentPage) }
            }
        }
    }
}

@Composable
private fun ViewerPage(
    item: ViewerItem,
    fetch: suspend () -> File,
    wrap: Boolean,
    mediaHttpClient: okhttp3.OkHttpClient?,
    onOpenExternally: () -> Unit,
    onDownload: () -> Unit,
) {
    val kind = previewKind(item.name, item.mime)
    if (kind == ViewerKind.UNSUPPORTED) {
        Unsupported(item, onOpenExternally, onDownload)
        return
    }

    // Media with a stream URL plays without a full download - no file fetch.
    val streams = (kind == ViewerKind.VIDEO || kind == ViewerKind.AUDIO) &&
        item.streamUrl != null && mediaHttpClient != null
    if (streams) {
        Box(Modifier.fillMaxSize().padding(top = 56.dp)) {
            MediaViewer(streamUrl = item.streamUrl, httpClient = mediaHttpClient)
        }
        return
    }

    // Otherwise fetch the bytes once for this page; the viewer reads the file.
    val file = produceState<Result<File>?>(initialValue = null, item.name) {
        value = withContext(Dispatchers.IO) { runCatching { fetch() } }
    }.value

    Box(Modifier.fillMaxSize().padding(top = 56.dp), contentAlignment = Alignment.Center) {
        when {
            file == null -> CircularProgressIndicator(color = Color.White)
            file.isFailure -> Unsupported(item, onOpenExternally, onDownload, failed = true)
            else -> when (kind) {
                ViewerKind.IMAGE -> ImageViewer(file.getOrThrow())
                ViewerKind.PDF -> PdfViewer(file.getOrThrow())
                ViewerKind.TEXT -> TextViewer(file.getOrThrow(), wrap)
                ViewerKind.VIDEO, ViewerKind.AUDIO -> MediaViewer(file = file.getOrThrow())
                ViewerKind.UNSUPPORTED -> Unsupported(item, onOpenExternally, onDownload)
            }
        }
    }
}

@Composable
private fun Unsupported(
    item: ViewerItem,
    onOpenExternally: () -> Unit,
    onDownload: () -> Unit,
    failed: Boolean = false,
) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.InsertDriveFile,
            contentDescription = null,
            tint = Color.White.copy(alpha = 0.6f),
            modifier = Modifier.size(48.dp),
        )
        Text(
            stringResource(if (failed) R.string.viewer_preview_unavailable else R.string.viewer_unsupported),
            color = Color.White.copy(alpha = 0.85f),
            modifier = Modifier.padding(top = 12.dp),
        )
        Row(Modifier.padding(top = 16.dp)) {
            BarIcon(Icons.Outlined.OpenInNew, "Ouvrir avec", onOpenExternally)
            BarIcon(Icons.Outlined.FileDownload, stringResource(R.string.viewer_download), onDownload)
        }
    }
}

@Composable
private fun BarIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick) {
        Icon(icon, contentDescription = label, tint = Color.White)
    }
}

// The web's viewer overlay ground: rgba(22,22,24,0.98).
private val OverlayBg = Color(0xFA161618)
