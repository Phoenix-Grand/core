package com.kubuno.android.account

import android.app.Service
import android.content.Intent
import android.os.IBinder
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * The binder end of [KubunoAuthenticator].
 *
 * The framework binds this service, in this process, whenever any app touches
 * a `com.kubuno` account - which is exactly what keeps every refresh inside a
 * single `TokenManager` instance.
 *
 * `@AndroidEntryPoint` gives the service field injection from the singleton
 * component, so the authenticator sees the very same registry and clients as
 * the UI: no second copy of the token state.
 */
@AndroidEntryPoint
class KubunoAuthenticatorService : Service() {

    @Inject lateinit var registry: AccountRegistry

    @Inject lateinit var clients: AccountClients

    // Built lazily: injection happens in onCreate, always before onBind.
    private val authenticator: KubunoAuthenticator by lazy {
        KubunoAuthenticator(this, registry, clients)
    }

    override fun onBind(intent: Intent?): IBinder = authenticator.iBinder
}
