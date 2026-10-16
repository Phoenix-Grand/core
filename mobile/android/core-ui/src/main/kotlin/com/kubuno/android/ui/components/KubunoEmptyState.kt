package com.kubuno.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kubuno.android.ui.theme.KubunoTheme

/** The tone of an empty state, mirroring EmptyState.tsx. */
enum class KubunoEmptyTone { FIRST_USE, NO_RESULTS, ERROR, UNAVAILABLE }

/**
 * An empty state (EmptyState.tsx): a tinted icon circle, a title, an optional
 * description, and an optional action row - centred.
 */
@Composable
fun KubunoEmptyState(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    tone: KubunoEmptyTone = KubunoEmptyTone.NO_RESULTS,
    compact: Boolean = false,
    actions: @Composable (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val kb = KubunoTheme.colors
    val (circle, tint) = when (tone) {
        KubunoEmptyTone.FIRST_USE -> scheme.primaryContainer to scheme.primary
        KubunoEmptyTone.NO_RESULTS -> scheme.surfaceVariant to scheme.onSurfaceVariant
        KubunoEmptyTone.ERROR -> scheme.errorContainer to scheme.error
        KubunoEmptyTone.UNAVAILABLE -> scheme.surfaceVariant to kb.textTertiary
    }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = if (compact) 16.dp else 24.dp, vertical = if (compact) 24.dp else 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 12.dp),
    ) {
        Surface(shape = CircleShape, color = circle, modifier = Modifier.size(if (compact) 44.dp else 56.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(if (compact) 22.dp else 28.dp))
            }
        }
        Text(
            title,
            style = if (compact) MaterialTheme.typography.titleSmall else MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = scheme.onSurface,
            textAlign = TextAlign.Center,
        )
        description?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        actions?.let {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { it() }
        }
    }
}
