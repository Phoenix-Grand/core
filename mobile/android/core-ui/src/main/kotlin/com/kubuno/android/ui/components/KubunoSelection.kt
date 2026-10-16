package com.kubuno.android.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/**
 * Selection controls drawn to the web design system's own geometry
 * (core/frontend/src/ui/{toggleCanvas,checkboxCanvas,radioCanvas}.ts), not
 * Material's. The web paints these on a canvas with exact pixel sizes, so they
 * are redrawn here rather than restyled: Material's switch is a pill with a big
 * circular thumb, while Kubuno's is a rounded RECTANGLE with a small square
 * thumb - restyling could never match it.
 *
 * Layout mirrors the web components: the control, then a label with an optional
 * secondary description; the whole row is the touch target.
 */

// TOGGLE_GEOMETRY from toggleCanvas.ts - a rounded rectangle, never a pill.
private data class ToggleGeom(
    val width: Int, val height: Int, val trackRadius: Int,
    val thumbSize: Int, val thumbRadius: Int, val thumbInset: Int,
)

private val ToggleMd = ToggleGeom(36, 20, 6, 14, 4, 3)
private val ToggleSm = ToggleGeom(28, 16, 5, 12, 3, 2)

// CHECKBOX_GEOMETRY / RADIO_GEOMETRY: an 18px box, a 2px stroke.
private const val BoxSize = 18
private const val BoxBorder = 2
private const val BoxRadius = 4
private const val TickSize = 11
private const val RadioDot = 10

/** The tick polygon from checkboxCanvas.ts, in 0..1 of the tick box. */
private val Tick = listOf(
    0.14f to 0.44f, 0f to 0.65f, 0.50f to 1f, 1f to 0.16f, 0.80f to 0f, 0.43f to 0.62f,
)

@Composable
private fun ControlRow(
    modifier: Modifier,
    control: @Composable () -> Unit,
    label: String?,
    description: String?,
) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        control()
        if (label != null || description != null) {
            Column(Modifier.padding(start = 10.dp)) {
                label?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface) }
                description?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
fun KubunoToggle(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    description: String? = null,
    enabled: Boolean = true,
    small: Boolean = false,
) {
    val g = if (small) ToggleSm else ToggleMd
    val scheme = MaterialTheme.colorScheme
    val progress by animateFloatAsState(if (checked) 1f else 0f, label = "toggle")
    // Off track is --color-surface-3, its outline --color-border, on is the primary.
    val offTrack = scheme.surfaceContainerHigh
    val outline = scheme.outline
    val on = scheme.primary

    ControlRow(
        modifier = modifier.toggleable(
            value = checked,
            enabled = enabled,
            role = Role.Switch,
            onValueChange = onCheckedChange,
        ),
        control = {
            Canvas(Modifier.size(g.width.dp, g.height.dp)) {
                val stroke = 1.dp.toPx()
                val half = stroke / 2
                val track = Size(size.width - stroke, size.height - stroke)
                val at = Offset(half, half)
                val radius = CornerRadius(g.trackRadius.dp.toPx())
                drawRoundRect(offTrack, at, track, radius)
                drawRoundRect(outline, at, track, radius, style = Stroke(stroke))
                if (progress > 0f) {
                    drawRoundRect(on, at, track, radius, alpha = progress)
                    drawRoundRect(on, at, track, radius, alpha = progress, style = Stroke(stroke))
                }
                val inset = g.thumbInset.dp.toPx()
                val thumb = g.thumbSize.dp.toPx()
                val travel = size.width - inset * 2 - thumb
                drawRoundRect(
                    Color.White,
                    Offset(inset + travel * progress, inset),
                    Size(thumb, thumb),
                    CornerRadius(g.thumbRadius.dp.toPx()),
                )
            }
        },
        label = label,
        description = description,
    )
}

@Composable
fun KubunoCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    description: String? = null,
    enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    val progress by animateFloatAsState(if (checked) 1f else 0f, label = "checkbox")
    ControlRow(
        modifier = modifier.toggleable(
            value = checked,
            enabled = enabled,
            role = Role.Checkbox,
            onValueChange = onCheckedChange,
        ),
        control = {
            Canvas(Modifier.size(BoxSize.dp)) {
                drawCheckboxBox(progress, scheme.surface, scheme.outline, scheme.primary)
            }
        },
        label = label,
        description = description,
    )
}

private fun DrawScope.drawCheckboxBox(progress: Float, fill: Color, outline: Color, accent: Color) {
    val border = BoxBorder.dp.toPx()
    val half = border / 2
    val box = Size(size.width - border, size.height - border)
    val at = Offset(half, half)
    val radius = CornerRadius(BoxRadius.dp.toPx() - half)
    drawRoundRect(fill, at, box, radius)
    drawRoundRect(outline, at, box, radius, style = Stroke(border))
    if (progress <= 0f) return
    drawRoundRect(accent, at, box, radius, alpha = progress)
    drawRoundRect(accent, at, box, radius, alpha = progress, style = Stroke(border))
    // Tick, scaling in from the centre exactly like the web's canvas painter.
    val s = TickSize.dp.toPx() * progress
    val ox = (size.width - s) / 2
    val oy = (size.height - s) / 2
    val path = Path().apply {
        Tick.forEachIndexed { index, (fx, fy) ->
            val x = ox + fx * s
            val y = oy + fy * s
            if (index == 0) moveTo(x, y) else lineTo(x, y)
        }
        close()
    }
    drawPath(path, Color.White)
}

@Composable
fun KubunoRadio(
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    description: String? = null,
    enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    val progress by animateFloatAsState(if (selected) 1f else 0f, label = "radio")
    ControlRow(
        modifier = modifier.selectable(
            selected = selected,
            enabled = enabled,
            role = Role.RadioButton,
            onClick = onClick,
        ),
        control = {
            Canvas(Modifier.size(BoxSize.dp)) {
                val ring = BoxBorder.dp.toPx()
                val radius = (size.minDimension - ring) / 2
                val centre = Offset(size.width / 2, size.height / 2)
                drawCircle(
                    color = if (progress > 0f) scheme.primary else scheme.outline,
                    radius = radius,
                    center = centre,
                    style = Stroke(ring),
                )
                if (progress > 0f) {
                    drawCircle(scheme.primary, (RadioDot.dp.toPx() / 2) * progress, centre)
                }
            }
        },
        label = label,
        description = description,
    )
}
