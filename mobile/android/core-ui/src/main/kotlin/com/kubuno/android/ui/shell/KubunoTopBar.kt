package com.kubuno.android.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import coil3.compose.LocalPlatformContext
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.kubuno.android.ui.R

/**
 * The Kubuno header, shared by every app in the suite: a menu button, the K
 * mark, then the actions and the account avatar. This is the row the drive app
 * established; extracting it here keeps the whole suite reading the same, while
 * each app tailors which actions it shows.
 *
 * Every action is optional - pass null to hide its slot - and [actions] lets an
 * app insert or override buttons before the avatar. The bell carries an
 * optional [notificationCount] badge. Search is a plain icon here; an app that
 * wants an inline search field swaps its own header in that mode.
 */
@Composable
fun KubunoTopBar(
    avatarLabel: String?,
    onAvatarClick: () -> Unit,
    modifier: Modifier = Modifier,
    avatarUrl: String? = null,
    onOpenMenu: (() -> Unit)? = null,
    onSearch: (() -> Unit)? = null,
    notificationCount: Int = 0,
    onNotifications: (() -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        onOpenMenu?.let {
            HeaderIcon(Icons.Outlined.Menu, stringResource(R.string.kubuno_menu), it)
        }
        Icon(
            painter = painterResource(R.drawable.ic_kubuno_logo),
            contentDescription = stringResource(R.string.kubuno_logo),
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = if (onOpenMenu == null) 16.dp else 0.dp)
                .size(width = 20.dp, height = 22.dp),
        )

        Box(Modifier.weight(1f))

        actions()
        onSearch?.let {
            HeaderIcon(Icons.Outlined.Search, stringResource(R.string.kubuno_search), it)
        }
        onNotifications?.let {
            NotificationBell(notificationCount, it)
        }
        onSettings?.let {
            HeaderIcon(Icons.Outlined.Settings, stringResource(R.string.kubuno_settings), it)
        }
        Avatar(avatarLabel, avatarUrl, onAvatarClick)
    }
}

@Composable
fun HeaderIcon(icon: ImageVector, contentDescription: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun NotificationBell(count: Int, onClick: () -> Unit) {
    Box(
        modifier = Modifier.size(48.dp).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Outlined.Notifications,
            contentDescription = stringResource(R.string.kubuno_notifications),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
        if (count > 0) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 10.dp, end = 8.dp)
                    .size(16.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.error),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (count > 9) "9+" else "$count",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onError,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

/**
 * Profile picture, falling back to initials. [avatarUrl] must be absolute; the
 * app's Coil loader rides its authenticated client so the avatar endpoint is
 * reachable.
 */
@Composable
fun Avatar(label: String?, avatarUrl: String?, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .padding(end = 6.dp)
            .size(36.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initialsOf(label),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onPrimary,
        )
        if (avatarUrl != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalPlatformContext.current)
                    .data(avatarUrl)
                    .crossfade(true)
                    .build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

internal fun initialsOf(label: String?): String = label
    ?.split(' ', '@', '.')
    ?.filter { it.isNotBlank() }
    ?.take(2)
    ?.joinToString("") { it.first().uppercase() }
    ?.ifBlank { null }
    ?: "?"
