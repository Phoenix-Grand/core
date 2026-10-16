package com.kubuno.android.account

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * The other Kubuno apps installed on this device - those signed with the same
 * certificate as us.
 *
 * Used both to grant a shared account visibility to its siblings and to borrow
 * an access token from whichever of them still holds a live session. Gating on
 * the signing certificate is what makes either safe: a package that merely
 * guessed the "com.kubuno" account type or the provider authority is excluded.
 */
object KubunoSiblings {

    fun packages(context: Context): List<String> {
        val pm = context.packageManager
        val mine = signaturesOf(pm, context.packageName) ?: return emptyList()
        @Suppress("DEPRECATION", "QueryPermissionsNeeded")
        return pm.getInstalledPackages(0)
            .map { it.packageName }
            .filter { it != context.packageName }
            .filter { signaturesOf(pm, it)?.let { sig -> sig.intersect(mine).isNotEmpty() } == true }
    }

    /** The app's signing certificates as SHA-256 hex, across API levels. */
    fun signaturesOf(pm: PackageManager, pkg: String): Set<String>? = runCatching {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
            val signing = info.signingInfo ?: return@runCatching null
            if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures
        }
        signatures?.mapNotNull { sig ->
            val digest = MessageDigest.getInstance("SHA-256").digest(sig.toByteArray())
            digest.joinToString("") { "%02x".format(it) }
        }?.toSet()
    }.getOrNull()
}
