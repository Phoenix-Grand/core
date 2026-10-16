package com.kubuno.android.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil3.compose.AsyncImage
import coil3.compose.LocalPlatformContext
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.kubuno.android.ui.R
import com.kubuno.android.ui.theme.KubunoTheme

/** One account as the panel needs it, mapped from each app's own model. */
data class UiAccount(
    val id: String,
    val label: String,
    val host: String,
    val avatarUrl: String? = null,
)

/**
 * The account card the avatar opens, shared across the suite: the active
 * account, the other accounts on the device to switch to, adding one, and the
 * system's own account settings.
 *
 * Every action beyond switching is optional - an app hides what it does not
 * offer (a consumer app with no sign-in of its own passes null for
 * [onManageAccount] and [onSignOut]). The account model is generic so both the
 * owner app (drive) and consumer apps (mail) feed the same panel.
 */
@Composable
fun KubunoAccountPanel(
    email: String?,
    displayName: String?,
    avatarUrl: String?,
    accounts: List<UiAccount>,
    activeId: String?,
    onSwitchAccount: (String) -> Unit,
    onManageDeviceAccounts: () -> Unit,
    onDismiss: () -> Unit,
    onAddAccount: (() -> Unit)? = null,
    onManageAccount: (() -> Unit)? = null,
    onSignOut: (() -> Unit)? = null,
) {
    Dialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .clip(MaterialTheme.shapes.large)
                .background(MaterialTheme.colorScheme.background)
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 16.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 4.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    email.orEmpty(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Outlined.Close,
                        contentDescription = stringResource(R.string.kubuno_close),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            Portrait(displayName ?: email, avatarUrl, 96.dp, Modifier.align(Alignment.CenterHorizontally))

            Spacer(Modifier.height(12.dp))
            Text(
                stringResource(R.string.kubuno_greeting, firstNameOf(displayName ?: email)),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .padding(horizontal = 24.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            onManageAccount?.let {
                Spacer(Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .clip(CircleShape)
                        .border(1.dp, MaterialTheme.colorScheme.primary, CircleShape)
                        .clickable(onClick = it)
                        .padding(horizontal = 24.dp, vertical = 10.dp),
                ) {
                    Text(
                        stringResource(R.string.kubuno_manage_account),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            Column(
                modifier = Modifier
                    .padding(horizontal = 12.dp)
                    .clip(MaterialTheme.shapes.large)
                    .background(MaterialTheme.colorScheme.surface),
            ) {
                accounts.filter { it.id != activeId }.forEach { account ->
                    AccountRow(account) { onSwitchAccount(account.id) }
                }
                onAddAccount?.let {
                    PanelRow(Icons.Outlined.PersonAdd, stringResource(R.string.kubuno_add_account), it)
                }
                PanelRow(
                    Icons.Outlined.ManageAccounts,
                    stringResource(R.string.kubuno_manage_device_accounts),
                    onManageDeviceAccounts,
                )
                onSignOut?.let {
                    PanelRow(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.kubuno_sign_out), it)
                }
            }
        }
    }
}

@Composable
private fun Portrait(label: String?, avatarUrl: String?, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initialsOf(label),
            fontSize = if (size > 60.dp) 28.sp else 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onPrimary,
        )
        if (avatarUrl != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalPlatformContext.current).data(avatarUrl).crossfade(true).build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun AccountRow(account: UiAccount, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Portrait(account.label, account.avatarUrl, 40.dp)
        Column(Modifier.weight(1f)) {
            Text(
                account.label,
                fontSize = 15.sp,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                account.host,
                style = MaterialTheme.typography.bodySmall,
                color = KubunoTheme.colors.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun PanelRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(
            modifier = Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
        Text(label, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
    }
}

private fun firstNameOf(label: String?): String =
    label?.substringBefore(' ')?.substringBefore('@')?.takeIf { it.isNotBlank() } ?: "?"
