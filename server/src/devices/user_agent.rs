//! Normalising a `User-Agent` into something an operator can read.
//!
//! ## Why this is written here rather than pulled from a crate
//!
//! The inventory needs four facts - device class, platform, platform version,
//! browser - and it needs them to be *stable*, because they feed the
//! fingerprint that correlates sessions opened before the inventory existed
//! (see [`super::correlate`]). A general-purpose parser optimises for coverage
//! of two decades of exotic strings; a change in its heuristics would silently
//! resplit an account's devices in two. Two hundred lines that this repository
//! owns, with the tests below pinning the shapes actually seen in production,
//! trade that coverage for a promise the feature depends on.
//!
//! ## What it deliberately does not do
//!
//! It does not pretend the result is verified. A user agent is a string the
//! client chose; everything derived from it is *observed*, and the console
//! labels it as such. The only stronger claim available anywhere in this feature
//! is a native application's declaration, and that one is labelled "declared by
//! the device" - never "verified".

use serde::Serialize;

/// Device classes. Strings rather than an enum on the wire: they are stored in
/// a `VARCHAR` with a CHECK, translated by key in the console, and read by the
/// filter select.
pub mod device_type {
    pub const DESKTOP: &str = "desktop";
    pub const MOBILE: &str = "mobile";
    pub const TABLET: &str = "tablet";
    pub const TV: &str = "tv";
    pub const BOT: &str = "bot";
    /// A programmatic client: `curl`, a script, a module.
    pub const API: &str = "api";
    pub const UNKNOWN: &str = "unknown";
}

/// What a user agent could be read to say. Every field is optional because
/// "I could not tell" is a legitimate and frequent answer, and inventing a
/// plausible value would be worse than admitting it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Normalised {
    pub device_type: String,
    pub platform: Option<String>,
    pub platform_version: Option<String>,
    pub browser: Option<String>,
    pub browser_version: Option<String>,
}

impl Normalised {
    fn unknown() -> Self {
        Self {
            device_type: device_type::UNKNOWN.to_string(),
            ..Self::default()
        }
    }

    /// Human description used as the fallback label of a device that the user
    /// has not named. Never empty: a nameless row in an inventory is a row
    /// nobody can act on.
    pub fn describe(&self) -> String {
        let platform = match (&self.platform, &self.platform_version) {
            (Some(p), Some(v)) => Some(format!("{p} {v}")),
            (Some(p), None) => Some(p.clone()),
            _ => None,
        };
        match (&self.browser, platform) {
            (Some(b), Some(p)) => format!("{b} sur {p}"),
            (Some(b), None) => b.clone(),
            (None, Some(p)) => p,
            (None, None) => "Appareil inconnu".to_string(),
        }
    }

    /// The part of the reading that is stable enough to correlate on.
    ///
    /// Only the MAJOR version of the platform: a browser that ships every four
    /// weeks would otherwise mint a new "device" per update, which is how an
    /// inventory becomes a changelog.
    pub fn fingerprint_material(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.device_type,
            self.platform.as_deref().unwrap_or("?"),
            major(self.platform_version.as_deref()).unwrap_or_else(|| "?".into()),
            self.browser.as_deref().unwrap_or("?"),
        )
    }
}

/// Leading numeric component of a version (`"17.4.1"` → `"17"`).
fn major(version: Option<&str>) -> Option<String> {
    let v = version?;
    let head: String = v.chars().take_while(char::is_ascii_digit).collect();
    if head.is_empty() {
        None
    } else {
        Some(head)
    }
}

/// Reads the token that follows `prefix`, stopping at the first character that
/// cannot belong to a version.
fn version_after(ua: &str, prefix: &str) -> Option<String> {
    let start = ua.find(prefix)? + prefix.len();
    let raw: String = ua[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '_')
        .collect();
    let cleaned = raw.replace('_', ".");
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Windows reports a kernel version. `Windows NT 10.0` covers both 10 and 11 -
/// the browsers froze it deliberately - so the mapping stops at 10 rather than
/// guessing, and a native application's declared version is what distinguishes
/// them when the operator turned that on.
fn windows_version(nt: &str) -> Option<String> {
    Some(
        match nt {
            "5.1" | "5.2" => "XP",
            "6.0" => "Vista",
            "6.1" => "7",
            "6.2" => "8",
            "6.3" => "8.1",
            "10.0" => "10",
            _ => return None,
        }
        .to_string(),
    )
}

/// Reads a user agent. Never fails: an unreadable string is a device of unknown
/// type, which is exactly what the row should then say.
pub fn normalise(raw: &str) -> Normalised {
    let ua = raw.trim();
    if ua.is_empty() {
        return Normalised::unknown();
    }
    let lower = ua.to_ascii_lowercase();

    // ── Non-browser clients, before anything else ────────────────────────────
    // A crawler that also claims "Mozilla/5.0" would otherwise be filed as a
    // desktop browser and pollute a real person's inventory.
    if let Some(found) = programmatic(ua, &lower) {
        return found;
    }
    // Kubuno's own applications announce themselves; trusting the format we
    // control beats inferring it back out of a Mozilla-compatible disguise.
    if let Some(found) = kubuno_app(ua) {
        return found;
    }

    let (platform, platform_version) = platform_of(ua, &lower);
    let (browser, browser_version) = browser_of(ua, &lower);
    let device = device_type_of(&lower, platform.as_deref());

    Normalised {
        device_type: device.to_string(),
        platform,
        platform_version,
        browser,
        browser_version,
    }
}

/// Command-line tools, libraries and crawlers.
fn programmatic(ua: &str, lower: &str) -> Option<Normalised> {
    const BOTS: &[&str] = &[
        "bot", "crawler", "spider", "slurp", "facebookexternalhit", "duckduckgo",
    ];
    const TOOLS: &[(&str, &str)] = &[
        ("curl/", "curl"),
        ("wget/", "Wget"),
        ("python-requests/", "python-requests"),
        ("python-urllib", "urllib"),
        ("httpie/", "HTTPie"),
        ("go-http-client/", "Go HTTP"),
        ("postmanruntime/", "Postman"),
        ("insomnia/", "Insomnia"),
        ("reqwest/", "reqwest"),
        ("axios/", "axios"),
        ("node-fetch/", "node-fetch"),
        ("okhttp/", "OkHttp"),
    ];

    for (needle, name) in TOOLS {
        if lower.contains(needle) {
            return Some(Normalised {
                device_type: device_type::API.to_string(),
                platform: None,
                platform_version: None,
                browser: Some((*name).to_string()),
                browser_version: version_after(ua, &ua[ua.to_ascii_lowercase().find(needle)?..][..needle.len()]),
            });
        }
    }
    if BOTS.iter().any(|b| lower.contains(b)) {
        return Some(Normalised {
            device_type: device_type::BOT.to_string(),
            browser: Some("Robot".to_string()),
            ..Normalised::default()
        });
    }
    None
}

/// `Kubuno/0.4.1 (Android 14; Pixel 7)` - the shape the native applications emit.
fn kubuno_app(ua: &str) -> Option<Normalised> {
    let rest = ua.strip_prefix("Kubuno/")?;
    let app_version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let inside = rest
        .split_once('(')
        .and_then(|(_, tail)| tail.split_once(')'))
        .map(|(inside, _)| inside)
        .unwrap_or("");
    let first = inside.split(';').next().unwrap_or("").trim();
    let (platform, platform_version) = match first.rsplit_once(' ') {
        Some((name, version)) if version.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
            (Some(name.trim().to_string()), Some(version.to_string()))
        }
        _ if !first.is_empty() => (Some(first.to_string()), None),
        _ => (None, None),
    };
    let lower_platform = platform.as_deref().unwrap_or("").to_ascii_lowercase();
    let device = if lower_platform.contains("android") || lower_platform.contains("ios") {
        device_type::MOBILE
    } else if lower_platform.contains("ipados") {
        device_type::TABLET
    } else if lower_platform.is_empty() {
        device_type::UNKNOWN
    } else {
        device_type::DESKTOP
    };

    Some(Normalised {
        device_type: device.to_string(),
        platform,
        platform_version,
        browser: Some("Application Kubuno".to_string()),
        browser_version: (!app_version.is_empty()).then_some(app_version),
    })
}

fn platform_of(ua: &str, lower: &str) -> (Option<String>, Option<String>) {
    // Order matters: "Android" strings also contain "Linux", and iPadOS also
    // contains "Mac OS X" on recent iPads.
    if lower.contains("windows nt") {
        let nt = version_after(ua, "Windows NT ");
        return (
            Some("Windows".into()),
            nt.as_deref().and_then(windows_version),
        );
    }
    if lower.contains("windows phone") {
        return (Some("Windows Phone".into()), version_after(ua, "Windows Phone "));
    }
    if lower.contains("android") {
        return (Some("Android".into()), version_after(ua, "Android "));
    }
    if lower.contains("cros") {
        return (Some("ChromeOS".into()), None);
    }
    if lower.contains("ipad") {
        // iPadOS reports "CPU OS 17_4" (and, in desktop mode, a macOS string).
        let v = version_after(ua, "CPU OS ").or_else(|| version_after(ua, "OS "));
        return (Some("iPadOS".into()), v);
    }
    if lower.contains("iphone") || lower.contains("ipod") {
        return (Some("iOS".into()), version_after(ua, "iPhone OS "));
    }
    if lower.contains("mac os x") || lower.contains("macintosh") {
        return (Some("macOS".into()), version_after(ua, "Mac OS X "));
    }
    for (needle, name) in [
        ("freebsd", "FreeBSD"),
        ("openbsd", "OpenBSD"),
        ("netbsd", "NetBSD"),
    ] {
        if lower.contains(needle) {
            return (Some(name.into()), None);
        }
    }
    if lower.contains("linux") || lower.contains("x11") {
        // Distributions that identify themselves are worth showing: an operator
        // reading "Ubuntu" learns more than from "Linux".
        for (needle, name) in [
            ("ubuntu", "Ubuntu"),
            ("fedora", "Fedora"),
            ("debian", "Debian"),
            ("arch", "Arch Linux"),
        ] {
            if lower.contains(needle) {
                return (Some(name.into()), None);
            }
        }
        return (Some("Linux".into()), None);
    }
    (None, None)
}

fn browser_of(ua: &str, lower: &str) -> (Option<String>, Option<String>) {
    // Strictly most-specific first. Every Chromium fork claims to be Chrome,
    // and Chrome claims to be Safari; reading them in the wrong order files a
    // whole fleet of Edge installs as Chrome.
    const TABLE: &[(&str, &str)] = &[
        ("edg/", "Edge"),
        ("edga/", "Edge"),
        ("edgios/", "Edge"),
        ("opr/", "Opera"),
        ("opera/", "Opera"),
        ("vivaldi/", "Vivaldi"),
        ("brave/", "Brave"),
        ("yabrowser/", "Yandex"),
        ("samsungbrowser/", "Samsung Internet"),
        ("fxios/", "Firefox"),
        ("firefox/", "Firefox"),
        ("crios/", "Chrome"),
        ("headlesschrome/", "Chrome sans interface"),
        ("chromium/", "Chromium"),
        ("chrome/", "Chrome"),
        ("electron/", "Electron"),
    ];

    for (needle, name) in TABLE {
        if let Some(at) = lower.find(needle) {
            let prefix = &ua[at..at + needle.len()];
            return (Some((*name).to_string()), version_after(ua, prefix));
        }
    }
    // Safari last, and only when nothing else matched: it is the token every
    // WebKit-derived agent carries.
    if lower.contains("safari/") {
        return (Some("Safari".into()), version_after(ua, "Version/"));
    }
    if lower.contains("gecko/") {
        return (Some("Gecko".into()), None);
    }
    (None, None)
}

fn device_type_of(lower: &str, platform: Option<&str>) -> &'static str {
    if lower.contains("smart-tv")
        || lower.contains("smarttv")
        || lower.contains("appletv")
        || lower.contains("googletv")
    {
        return device_type::TV;
    }
    match platform {
        Some("iPadOS") => return device_type::TABLET,
        Some("iOS") | Some("Windows Phone") => return device_type::MOBILE,
        Some("Android") => {
            // Android tablets omit the "Mobile" token; phones carry it. This is
            // the only signal the string offers, and it is the one Google's own
            // documentation points at.
            return if lower.contains("mobile") {
                device_type::MOBILE
            } else {
                device_type::TABLET
            };
        }
        Some(_) => return device_type::DESKTOP,
        None => {}
    }
    if lower.contains("mobile") {
        device_type::MOBILE
    } else {
        device_type::UNKNOWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(ua: &str) -> Normalised {
        normalise(ua)
    }

    #[test]
    fn windows_chrome() {
        let r = n("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
        assert_eq!(r.device_type, device_type::DESKTOP);
        assert_eq!(r.platform.as_deref(), Some("Windows"));
        assert_eq!(r.platform_version.as_deref(), Some("10"));
        assert_eq!(r.browser.as_deref(), Some("Chrome"));
        assert_eq!(r.browser_version.as_deref(), Some("126.0.0.0"));
    }

    /// Every Chromium fork claims to be Chrome. Reading the table in the wrong
    /// order files an entire Edge deployment as Chrome.
    #[test]
    fn edge_is_not_chrome_and_opera_is_not_chrome() {
        let edge = n("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68");
        assert_eq!(edge.browser.as_deref(), Some("Edge"));
        assert_eq!(edge.browser_version.as_deref(), Some("126.0.2592.68"));

        let opera = n("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0");
        assert_eq!(opera.browser.as_deref(), Some("Opera"));
    }

    #[test]
    fn macos_safari_reads_its_version_from_the_version_token() {
        let r = n("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15");
        assert_eq!(r.platform.as_deref(), Some("macOS"));
        assert_eq!(r.platform_version.as_deref(), Some("10.15.7"));
        assert_eq!(r.browser.as_deref(), Some("Safari"));
        assert_eq!(r.browser_version.as_deref(), Some("17.4.1"));
        assert_eq!(r.device_type, device_type::DESKTOP);
    }

    #[test]
    fn iphone_is_mobile_and_ipad_is_a_tablet() {
        let phone = n("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
        assert_eq!(phone.platform.as_deref(), Some("iOS"));
        assert_eq!(phone.platform_version.as_deref(), Some("17.4"));
        assert_eq!(phone.device_type, device_type::MOBILE);

        let pad = n("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
        assert_eq!(pad.platform.as_deref(), Some("iPadOS"));
        assert_eq!(pad.device_type, device_type::TABLET);
    }

    /// The `Mobile` token is the only thing that separates an Android phone
    /// from an Android tablet.
    #[test]
    fn android_phone_versus_tablet() {
        let phone = n("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
        assert_eq!(phone.platform.as_deref(), Some("Android"));
        assert_eq!(phone.platform_version.as_deref(), Some("14"));
        assert_eq!(phone.device_type, device_type::MOBILE);

        let tablet = n("Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
        assert_eq!(tablet.device_type, device_type::TABLET);
    }

    #[test]
    fn linux_firefox_and_named_distributions() {
        let r = n("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0");
        assert_eq!(r.platform.as_deref(), Some("Linux"));
        assert_eq!(r.browser.as_deref(), Some("Firefox"));
        assert_eq!(r.browser_version.as_deref(), Some("127.0"));

        let ubuntu = n("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0");
        assert_eq!(ubuntu.platform.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn command_line_clients_are_api_not_desktop() {
        let r = n("curl/8.5.0");
        assert_eq!(r.device_type, device_type::API);
        assert_eq!(r.browser.as_deref(), Some("curl"));

        let bot = n("Mozilla/5.0 (compatible; SomeBot/2.1; +http://example.test/bot)");
        assert_eq!(bot.device_type, device_type::BOT);
    }

    #[test]
    fn the_native_application_announces_itself() {
        let r = n("Kubuno/0.4.1 (Android 14; Pixel 7)");
        assert_eq!(r.platform.as_deref(), Some("Android"));
        assert_eq!(r.platform_version.as_deref(), Some("14"));
        assert_eq!(r.browser.as_deref(), Some("Application Kubuno"));
        assert_eq!(r.browser_version.as_deref(), Some("0.4.1"));
        assert_eq!(r.device_type, device_type::MOBILE);
    }

    #[test]
    fn an_unreadable_agent_says_so_instead_of_guessing() {
        let r = n("");
        assert_eq!(r.device_type, device_type::UNKNOWN);
        assert_eq!(r.platform, None);
        assert_eq!(r.browser, None);
        assert_eq!(r.describe(), "Appareil inconnu");
    }

    #[test]
    fn description_reads_as_a_sentence() {
        let r = n("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0");
        assert_eq!(r.describe(), "Firefox sur Linux");
    }

    /// A browser that ships every four weeks must not mint a new device on
    /// every update: the fingerprint keeps only the platform's major version.
    #[test]
    fn fingerprint_survives_a_browser_update() {
        let before = n("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
        let after = n("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
        assert_eq!(before.fingerprint_material(), after.fingerprint_material());
    }

    /// …but a different machine must not be folded into the same row.
    #[test]
    fn fingerprint_separates_two_real_machines() {
        let laptop = n("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15");
        let phone = n("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1");
        assert_ne!(laptop.fingerprint_material(), phone.fingerprint_material());
    }
}
