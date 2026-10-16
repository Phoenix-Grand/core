// Top-level build file: plugin versions come from gradle/libs.versions.toml.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}

// Every library is published as com.kubuno.mobile:<project name>:<kubunoMobileVersion>
// (gradle.properties). Module apps resolve them from the Kubuno Maven repository,
// or substitute this build in place (composite build, see README.md).
val kubunoMobileVersion = providers.gradleProperty("kubunoMobileVersion").get()

// Target of `publish`: the Maven package registry of the core project on the Kubuno
// GitLab. The token is read from ~/.gradle/gradle.properties (kubunoGitlabToken) or
// the KUBUNO_GITLAB_TOKEN environment variable, never from this repository.
val publishUrl = providers.gradleProperty("kubunoMavenPublishUrl")
    .orElse("http://gitlab.olinga.lan/api/v4/projects/19/packages/maven")
val gitlabToken = providers.gradleProperty("kubunoGitlabToken")
    .orElse(providers.environmentVariable("KUBUNO_GITLAB_TOKEN"))
// Private-Token for a personal/project access token, Deploy-Token or Job-Token otherwise.
val gitlabTokenHeader = providers.gradleProperty("kubunoGitlabTokenHeader").orElse("Private-Token")

subprojects {
    group = "com.kubuno.mobile"
    version = kubunoMobileVersion

    fun configurePublishing(component: String) {
        apply(plugin = "maven-publish")
        afterEvaluate {
            extensions.configure<PublishingExtension> {
                publications.register<MavenPublication>("release") {
                    from(components[component])
                    pom {
                        name.set("Kubuno mobile - ${project.name}")
                        url.set("https://github.com/kubuno/core/tree/main/mobile")
                        licenses {
                            license {
                                name.set("AGPL-3.0-or-later")
                                url.set("https://www.gnu.org/licenses/agpl-3.0.html")
                            }
                        }
                    }
                }
                repositories {
                    maven {
                        name = "kubuno"
                        url = uri(publishUrl.get())
                        // A file:// URL stages the artifacts locally (CI); http(s) is the registry.
                        if (url.scheme == "http" || url.scheme == "https") {
                            isAllowInsecureProtocol = url.scheme == "http"
                            credentials(HttpHeaderCredentials::class) {
                                name = gitlabTokenHeader.get()
                                value = gitlabToken.orNull
                            }
                            authentication { create<HttpHeaderAuthentication>("header") }
                        }
                    }
                }
            }
        }
    }

    pluginManager.withPlugin("com.android.library") {
        extensions.configure<com.android.build.api.dsl.LibraryExtension> {
            publishing {
                singleVariant("release") { withSourcesJar() }
            }
        }
        configurePublishing("release")
    }
    pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
        extensions.configure<JavaPluginExtension> { withSourcesJar() }
        configurePublishing("java")
    }
}
