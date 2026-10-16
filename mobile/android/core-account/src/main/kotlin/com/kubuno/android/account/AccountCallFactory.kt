package com.kubuno.android.account

import javax.inject.Inject
import javax.inject.Singleton
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Routes an image request to the account that owns the URL.
 *
 * Coil takes a single call factory for the whole process, but thumbnails and
 * avatars belong to whichever instance they came from - the switcher shows
 * every account's portrait at once. Picking the client by URL prefix keeps
 * each request on its own session, so one server never receives another's
 * bearer token.
 */
@Singleton
class AccountCallFactory @Inject constructor(
    private val registry: AccountRegistry,
    private val clients: AccountClients,
) : Call.Factory {

    /** For URLs belonging to no known account: no credentials attached. */
    private val anonymous by lazy { OkHttpClient() }

    override fun newCall(request: Request): Call {
        val url = request.url.toString()
        val owner = registry.accounts.value
            // Longest prefix wins: two instances can share a host and differ
            // only by path (`https://host/` and `https://host/kubuno`).
            .filter { url.startsWith(it.serverUrl) }
            .maxByOrNull { it.serverUrl.length }
        val client = owner?.let { clients.of(it.id) }?.okHttpClient ?: anonymous
        return client.newCall(request)
    }
}
