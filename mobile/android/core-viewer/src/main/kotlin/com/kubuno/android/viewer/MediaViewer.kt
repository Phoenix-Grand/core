package com.kubuno.android.viewer

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import android.net.Uri
import okhttp3.OkHttpClient
import java.io.File

/**
 * Video and audio with Media3/ExoPlayer.
 *
 * A [streamUrl] plays over the app's authenticated OkHttp client, so playback
 * streams with byte-range requests instead of downloading the whole file first -
 * the difference between a movie starting at once and staring at a spinner.
 * Falls back to the local [file] (e.g. an already-cached attachment) when no
 * URL is given.
 */
@Composable
fun MediaViewer(
    modifier: Modifier = Modifier,
    streamUrl: String? = null,
    httpClient: OkHttpClient? = null,
    file: File? = null,
) {
    val context = LocalContext.current
    val player = remember(streamUrl, file) {
        ExoPlayer.Builder(context).build().apply {
            val item = when {
                streamUrl != null -> MediaItem.fromUri(Uri.parse(streamUrl))
                file != null -> MediaItem.fromUri(Uri.fromFile(file))
                else -> null
            }
            if (item != null) {
                if (streamUrl != null && httpClient != null) {
                    // Stream over the authenticated client (Bearer + refresh live
                    // in its interceptor); ExoPlayer issues Range requests.
                    val factory = DefaultDataSource.Factory(
                        context,
                        OkHttpDataSource.Factory(httpClient),
                    )
                    setMediaSource(ProgressiveMediaSource.Factory(factory).createMediaSource(item))
                } else {
                    setMediaItem(item)
                }
                prepare()
                playWhenReady = true
            }
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx -> PlayerView(ctx).apply { this.player = player; useController = true } },
    )
}
