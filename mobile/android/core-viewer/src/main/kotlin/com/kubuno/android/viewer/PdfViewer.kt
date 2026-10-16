package com.kubuno.android.viewer

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * PDF rendered with Android's built-in [PdfRenderer] - pages rasterised to
 * bitmaps in a scrolling column, with pinch-to-zoom over the whole document.
 *
 * The web used pdf.js with a selectable text layer, search and anchored
 * comments; those do not port to PdfRenderer, so this is render + paginate +
 * zoom, which covers reading an attachment. Pages render lazily as they scroll
 * into view.
 */
@Composable
fun PdfViewer(file: File, modifier: Modifier = Modifier) {
    val renderer = produceState<PdfPages?>(initialValue = null, file) {
        value = withContext(Dispatchers.IO) {
            runCatching { PdfPages.open(file) }.getOrNull()
        }
    }.value

    var scale by remember { mutableFloatStateOf(1f) }

    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            renderer == null -> CircularProgressIndicator()
            renderer.pageCount == 0 -> Text("PDF illisible", color = androidx.compose.ui.graphics.Color.White)
            else -> {
                DisposableEffect(renderer) { onDispose { renderer.close() } }
                val widthPx = with(LocalDensity.current) {
                    LocalConfiguration.current.screenWidthDp.dp.toPx().toInt()
                }
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTransformGestures { _, _, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 4f)
                            }
                        }
                        .graphicsLayer { scaleX = scale; scaleY = scale },
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp),
                ) {
                    items((0 until renderer.pageCount).toList()) { index ->
                        PdfPage(renderer, index, widthPx)
                    }
                }
            }
        }
    }
}

@Composable
private fun PdfPage(pages: PdfPages, index: Int, widthPx: Int) {
    val bitmap = produceState<Bitmap?>(initialValue = null, index) {
        value = withContext(Dispatchers.IO) { runCatching { pages.render(index, widthPx) }.getOrNull() }
    }.value
    Box(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        val bmp = bitmap
        if (bmp != null) {
            Image(bitmap = bmp.asImageBitmap(), contentDescription = "Page ${index + 1}", modifier = Modifier.fillMaxWidth())
        } else {
            CircularProgressIndicator(Modifier.padding(32.dp))
        }
    }
}

/** Thread-confined wrapper around PdfRenderer; render calls are serialised. */
private class PdfPages private constructor(
    private val descriptor: ParcelFileDescriptor,
    private val renderer: PdfRenderer,
) {
    val pageCount: Int get() = renderer.pageCount
    private val lock = Any()

    fun render(index: Int, widthPx: Int): Bitmap = synchronized(lock) {
        renderer.openPage(index).use { page ->
            val ratio = page.height.toFloat() / page.width
            val w = widthPx.coerceAtLeast(1)
            val h = (w * ratio).toInt().coerceAtLeast(1)
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bitmap
        }
    }

    fun close() = synchronized(lock) {
        runCatching { renderer.close() }
        runCatching { descriptor.close() }
    }

    companion object {
        fun open(file: File): PdfPages {
            val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            return PdfPages(fd, PdfRenderer(fd))
        }
    }
}
