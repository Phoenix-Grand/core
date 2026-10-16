package com.kubuno.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kubuno.android.ui.theme.KubunoTheme

/**
 * The Kubuno button, transcribed from the web design system (core/frontend/
 * src/ui/Button.tsx). Colour and fill carry the hierarchy - buttons are NEVER
 * bold, and the radius is fixed at 6dp (rounded-md), never overridable.
 */
enum class KubunoButtonVariant { PRIMARY, SECONDARY, GHOST, TEXT, DANGER, TEXT_DANGER }

enum class KubunoButtonSize(val height: Int, val horizontal: Int) {
    SM(32, 12), MD(36, 16), LG(44, 20)
}

private val ButtonShape = RoundedCornerShape(6.dp)

@Composable
fun KubunoButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: KubunoButtonVariant = KubunoButtonVariant.PRIMARY,
    size: KubunoButtonSize = KubunoButtonSize.MD,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: @Composable (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val pad = PaddingValues(horizontal = size.horizontal.dp)
    val sizing = modifier
        .height(size.height.dp)
        .defaultMinSize(minWidth = 1.dp, minHeight = size.height.dp)

    val label: @Composable () -> Unit = {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
        } else {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                icon?.let { it(); androidx.compose.foundation.layout.Spacer(Modifier.size(6.dp)) }
                // Buttons are never bold.
                Text(text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Normal)
            }
        }
    }

    when (variant) {
        KubunoButtonVariant.PRIMARY -> Button(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad, elevation = null,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primary, contentColor = Color.White),
        ) { label() }

        KubunoButtonVariant.DANGER -> Button(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad, elevation = null,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.error, contentColor = Color.White),
        ) { label() }

        KubunoButtonVariant.SECONDARY -> OutlinedButton(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad,
            border = BorderStroke(1.dp, KubunoTheme.colors.borderStrong),
            colors = ButtonDefaults.outlinedButtonColors(
                containerColor = scheme.surface,
                contentColor = scheme.onSurface,
            ),
        ) { label() }

        KubunoButtonVariant.GHOST -> TextButton(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad,
            colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSurfaceVariant),
        ) { label() }

        KubunoButtonVariant.TEXT -> TextButton(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad,
            colors = ButtonDefaults.textButtonColors(contentColor = scheme.primary),
        ) { label() }

        KubunoButtonVariant.TEXT_DANGER -> TextButton(
            onClick = onClick, enabled = enabled && !loading, modifier = sizing, shape = ButtonShape,
            contentPadding = pad,
            colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
        ) { label() }
    }
}
