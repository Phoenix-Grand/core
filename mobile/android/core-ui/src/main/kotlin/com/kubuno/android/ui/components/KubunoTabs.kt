package com.kubuno.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** A tab item: a stable id and its visible label. */
data class KubunoTab(val id: String, val label: String)

enum class KubunoTabsVariant { PILLS, UNDERLINED }

/**
 * Tabs from the web design system (Tabs.tsx): "pills" (active = primary-light
 * fill) or "underlined" (active = primary text with a 3dp indicator). Labels are
 * medium weight, never bold.
 */
@Composable
fun KubunoTabs(
    tabs: List<KubunoTab>,
    selectedId: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    variant: KubunoTabsVariant = KubunoTabsVariant.PILLS,
) {
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier,
        horizontalArrangement = if (variant == KubunoTabsVariant.PILLS) Arrangement.spacedBy(4.dp) else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        tabs.forEach { tab ->
            val active = tab.id == selectedId
            when (variant) {
                KubunoTabsVariant.PILLS -> Box(
                    Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (active) scheme.primaryContainer else Color.Transparent)
                        .clickable { onSelect(tab.id) }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        tab.label,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = if (active) scheme.primary else scheme.onSurfaceVariant,
                    )
                }

                // IntrinsicSize.Max sizes the column to its label. Without it
                // the underline's fillMaxWidth() resolves against the row's
                // remaining width, so the first tab swallows the whole row and
                // every later tab is laid out at zero width - invisible.
                KubunoTabsVariant.UNDERLINED -> androidx.compose.foundation.layout.Column(
                    Modifier
                        .width(IntrinsicSize.Max)
                        .clickable { onSelect(tab.id) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        tab.label,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = if (active) scheme.primary else scheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                    Box(
                        Modifier
                            .padding(horizontal = 8.dp)
                            .fillMaxWidth()
                            .height(3.dp)
                            .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                            .background(if (active) scheme.primary else Color.Transparent),
                    )
                }
            }
        }
    }
}
