# Kubuno mobile - iOS

Reserved for what iOS does differently in the shared mobile libraries: the Keychain session store, the Darwin HTTP
engine, the native viewers (AVKit, PDFKit), the push registration.

Nothing yet: the iOS apps come with the Kotlin Multiplatform conversion of `../common`, built and signed on a Mac
(see [`../README.md`](../README.md#phase-2--kotlin-multiplatform-and-ios)). The API specification of the platform
(`kubuno/api-spec`) also publishes a generated Swift client.
