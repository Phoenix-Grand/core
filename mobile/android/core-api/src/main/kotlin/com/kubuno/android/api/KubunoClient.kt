package com.kubuno.android.api

import com.kubuno.android.api.auth.TokenManager
import com.kubuno.android.api.auth.TokenStore
import com.kubuno.android.api.net.AuthHeaderInterceptor
import com.kubuno.android.api.net.DeviceKeyProvider
import com.kubuno.android.api.net.TokenAuthenticator
import java.util.concurrent.ExecutorService
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * Everything needed to talk to ONE Kubuno instance as ONE account.
 *
 * The base URL is fixed at construction. It used to be a mutable field shared
 * by the whole app, which with several accounts live at once would let a
 * request leave for one server carrying another's bearer - a cross-instance
 * leak, not merely a stale read. One client per account removes the question.
 *
 * Connection pool and dispatcher are injected so that N accounts share one set
 * of sockets and threads instead of N.
 */
class KubunoClient(
    val baseUrl: String,
    tokenStore: TokenStore,
    deviceKeyProvider: DeviceKeyProvider,
    shared: SharedHttp,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        // Without this, defaulted fields like LoginRequest.clientType="native"
        // are omitted and the server falls back to the web cookie flow.
        encodeDefaults = true
    }

    private val normalisedBase = normalize(baseUrl)

    /** Owned by this client alone - see [SharedHttp] for why. */
    private val dispatcher = Dispatcher(shared.executor)

    /** Where [shutdown] runs, since closing sockets may not touch the main thread. */
    private val ioExecutor = shared.executor

    val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectionPool(shared.connectionPool)
        .dispatcher(dispatcher)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor(AuthHeaderInterceptor({ tokenManager }, deviceKeyProvider))
        .authenticator(TokenAuthenticator { tokenManager })
        .build()

    private val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl("$normalisedBase/")
        .client(okHttpClient)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    val authApi: AuthApi = retrofit.create(AuthApi::class.java)

    val driveApi: DriveApi = retrofit.create(DriveApi::class.java)

    val tokenManager: TokenManager = TokenManager(authApi, tokenStore)

    fun serverBaseUrl(): String = normalisedBase

    /**
     * Drops this client's in-flight calls. Fire-and-forget on purpose:
     * cancelling closes sockets, which Android forbids on the main thread, and
     * every caller (sign-out, abandoning a sign-in attempt) is on it.
     *
     * The connection pool is not evicted: it belongs to every account, and
     * idle connections expire on their own.
     */
    fun shutdown() {
        ioExecutor.execute { dispatcher.cancelAll() }
    }

    companion object {
        /** Accepts what users type: adds https://, strips trailing slashes. */
        fun normalize(input: String): String {
            var url = input.trim().trimEnd('/')
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "https://$url"
            }
            return url
        }
    }
}

/**
 * Sockets and worker threads shared by every account's client. Pooling them
 * keeps a device with several accounts from paying N times for idle
 * connections and dispatcher threads.
 *
 * The [Dispatcher] itself is deliberately NOT shared: it is the unit of
 * cancellation, so one shared instance would mean signing an account out
 * aborted the other accounts' in-flight uploads. Each client gets its own,
 * backed by this executor, which is what actually costs threads.
 */
class SharedHttp {
    val connectionPool: ConnectionPool = ConnectionPool()

    /**
     * Unbounded like OkHttp's own default (calls are already capped by the
     * dispatcher), with threads that die after a minute of idleness.
     */
    val executor: ExecutorService = ThreadPoolExecutor(
        0,
        Int.MAX_VALUE,
        60,
        TimeUnit.SECONDS,
        SynchronousQueue(),
    ) { runnable -> Thread(runnable, "kubuno-http").apply { isDaemon = false } }
}
