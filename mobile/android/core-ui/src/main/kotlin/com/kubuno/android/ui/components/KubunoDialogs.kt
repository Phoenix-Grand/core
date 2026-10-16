package com.kubuno.android.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.fillMaxWidth

/**
 * A confirm dialog (ConfirmDialog.tsx): a title, a message, a ghost cancel and a
 * primary - or danger - confirm, built from the shared Kubuno buttons.
 */
@Composable
fun KubunoConfirmDialog(
    title: String,
    message: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    confirmText: String = "Confirmer",
    cancelText: String = "Annuler",
    danger: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = { Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
        confirmButton = {
            KubunoButton(
                text = confirmText,
                onClick = onConfirm,
                variant = if (danger) KubunoButtonVariant.DANGER else KubunoButtonVariant.PRIMARY,
                size = KubunoButtonSize.SM,
            )
        },
        dismissButton = {
            KubunoButton(text = cancelText, onClick = onDismiss, variant = KubunoButtonVariant.GHOST, size = KubunoButtonSize.SM)
        },
        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    )
}

/**
 * A prompt dialog (PromptDialog.tsx): a labelled Kubuno text field and a
 * confirm that hands back the entered value.
 */
@Composable
fun KubunoPromptDialog(
    title: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    label: String? = null,
    placeholder: String? = null,
    initialValue: String = "",
    confirmText: String = "Valider",
    cancelText: String = "Annuler",
) {
    var value by remember { mutableStateOf(initialValue) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            KubunoTextField(
                value = value,
                onValueChange = { value = it },
                modifier = Modifier.fillMaxWidth(),
                label = label,
                placeholder = placeholder,
            )
        },
        confirmButton = {
            KubunoButton(
                text = confirmText,
                onClick = { if (value.isNotBlank()) onConfirm(value) },
                enabled = value.isNotBlank(),
                size = KubunoButtonSize.SM,
            )
        },
        dismissButton = {
            KubunoButton(text = cancelText, onClick = onDismiss, variant = KubunoButtonVariant.GHOST, size = KubunoButtonSize.SM)
        },
        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    )
}
