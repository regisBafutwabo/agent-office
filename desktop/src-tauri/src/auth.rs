//! Who may talk to the office. Mirrors bridge/auth.js; both servers share the same two files, so hooks and open
//! pages work with whichever is running. Each lives in the data folder, readable only by its owner:
//!   ui-token    the office page's key: read state, see code, answer permission requests (Authorization: Bearer …)
//!   hook-token  the hooks' key, kept as a curl header line: report events and ask for permission, nothing else
//! Requests must also name this office in Host (an IP address, localhost, or a name you allowed), so a web page
//! that rebinds its own domain to 127.0.0.1 can't reach it, and a browser's Origin must be the office itself.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const HOOK_HEADER: &str = "X-Agent-Office-Token";
pub const WS_PROTOCOL: &str = "agent-office";
const WS_TOKEN: &str = "agent-office.token.";
/// How long the one-time code in an "Open in browser" link works.
const CODE_LIFE: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Credentials {
    pub ui: String,
    pub hook: String,
    /// The data folder, where one-time sign-in codes are kept for whichever office holds the port.
    pub dir: PathBuf,
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENT_OFFICE_DATA").filter(|d| !d.is_empty()) {
        return dir.into();
    }
    let home = PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Agent Office")
    } else if cfg!(windows) {
        home.join("AppData/Roaming/Agent Office")
    } else {
        home.join(".config/agent-office")
    }
}

pub fn random_hex() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("the system has no random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn wrap(name: &str, token: &str) -> String {
    if name == "hook-token" { format!("{HOOK_HEADER}: {token}\n") } else { format!("{token}\n") }
}

fn unwrap_token<'a>(name: &str, text: &'a str) -> &'a str {
    let t = text.trim();
    if name != "hook-token" { return t; }
    match t.split_once(':') {
        Some((h, v)) if h.trim().eq_ignore_ascii_case(HOOK_HEADER) => v.trim(),
        _ => t,
    }
}

#[cfg(unix)]
fn open_existing(file: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(file)?;
    let meta = f.metadata()?;
    // SAFETY: getuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { libc::getuid() } {
        return Err(std::io::Error::other(format!("{} belongs to another user", file.display())));
    }
    if meta.mode() & 0o077 != 0 {
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(f)
}
#[cfg(not(unix))]
fn open_existing(file: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(file)
}

fn create_new(file: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(file)
}

/// The secret in <dir>/<name>, created on first use. Only its owner may read it; looser permissions are tightened.
pub fn secret(dir: &Path, name: &str) -> std::io::Result<String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let file = dir.join(name);
    for _ in 0..3 {
        match open_existing(&file) {
            Ok(mut f) => {
                let mut text = String::new();
                if f.read_to_string(&mut text).is_ok() && is_token(unwrap_token(name, &text)) {
                    return Ok(unwrap_token(name, &text).to_string());
                }
                std::fs::remove_file(&file)?; // unreadable or not one of ours: replace it
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let token = random_hex();
        match create_new(&file) {
            Ok(mut f) => {
                f.write_all(wrap(name, &token).as_bytes())?;
                return Ok(token);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue, // the other server made it first
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other(format!("Could not create {}", file.display())))
}

pub fn credentials(dir: &Path) -> std::io::Result<Credentials> {
    Ok(Credentials { ui: secret(dir, "ui-token")?, hook: secret(dir, "hook-token")?, dir: dir.to_path_buf() })
}

/// Keys that last only as long as this app, when the data folder can't be written. The window still opens with
/// its key; hooks can't report until the folder is fixed.
pub fn ephemeral() -> Credentials {
    Credentials { ui: random_hex(), hook: random_hex(), dir: data_dir() }
}

/// Constant-time, so how long a wrong key takes says nothing about the right one.
pub fn same(given: Option<&str>, expected: &str) -> bool {
    let Some(given) = given else { return false };
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// "localhost:4747", "127.0.0.1:4747", "[::1]:4747", a LAN address, or a name listed in `extra`, on this port.
/// A rebinding attack needs its own domain name in Host, so IP literals and localhost are safe to accept.
pub fn host_ok(host: Option<&str>, port: u16, extra: &[String]) -> bool {
    let Some(host) = host else { return false };
    let (name, p) = if let Some(rest) = host.strip_prefix('[') {
        let Some((ip, tail)) = rest.split_once(']') else { return false };
        if ip.parse::<std::net::Ipv6Addr>().is_err() { return false; }
        (format!("[{ip}]"), tail)
    } else {
        let (n, tail) = host.find(':').map_or((host, ""), |i| (&host[..i], &host[i..]));
        if n.is_empty() || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') { return false; }
        (n.to_ascii_lowercase(), tail)
    };
    let p = match p {
        "" => 80,
        t => match t.strip_prefix(':').filter(|d| !d.is_empty() && d.len() <= 5 && d.bytes().all(|b| b.is_ascii_digit())) {
            Some(d) => d.parse::<u32>().unwrap_or(0),
            None => return false,
        },
    };
    p == u32::from(port) && (name == "localhost" || name.starts_with('[') || name.parse::<std::net::Ipv4Addr>().is_ok() || extra.contains(&name))
}

/// Browsers name the page in Origin; it must be this office, as the page itself addressed it. Hooks send none.
pub fn origin_ok(origin: Option<&str>, host: Option<&str>) -> bool {
    match (origin, host) {
        (None, _) => true,
        (Some(o), Some(h)) => o.eq_ignore_ascii_case(&format!("http://{h}")),
        _ => false,
    }
}

pub fn bearer(authorization: Option<&str>) -> Option<&str> {
    let (scheme, token) = authorization?.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// Browsers can't set headers on a WebSocket, so the page offers its key as a second subprotocol.
pub fn ws_token(protocols: Option<&str>) -> Option<&str> {
    protocols?.split(',').map(str::trim).find_map(|p| p.strip_prefix(WS_TOKEN))
}

/// One-time sign-in codes for the "Open in browser" link. The link passes through `open`'s command line, which
/// other users can read, so it carries a code instead of the key. Whichever office holds the port must redeem it
/// (this app, or `npm start`'s bridge), so codes live in the data folder, not in this process:
/// login-codes/<sha256 of the code>, an empty file made 0600 in a folder kept 0700. Redeeming deletes the file, and
/// only one deletion can succeed, so a code works once, and only within a minute. bridge/auth.js reads the same files.
pub fn code_file(dir: &Path, code: &str) -> PathBuf {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(code.as_bytes());
    dir.join("login-codes").join(hash.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

#[cfg(unix)]
fn owned_by_me(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid has no preconditions and cannot fail.
    meta.uid() == unsafe { libc::getuid() }
}
#[cfg(not(unix))]
fn owned_by_me(_: &std::fs::Metadata) -> bool { true }

fn codes_dir(dir: &Path) -> std::io::Result<PathBuf> {
    let d = dir.join("login-codes");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&d)?;
    let meta = std::fs::symlink_metadata(&d)?;
    if !meta.is_dir() || !owned_by_me(&meta) {
        return Err(std::io::Error::other(format!("{} is not this user's folder", d.display())));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(d)
}

fn age(meta: &std::fs::Metadata) -> Option<Duration> {
    let modified = meta.modified().ok()?;
    Some(SystemTime::now().duration_since(modified).unwrap_or_else(|e| if e.duration() < Duration::from_secs(5) { Duration::ZERO } else { CODE_LIFE }))
}

pub fn launch_code(dir: &Path) -> std::io::Result<String> {
    let d = codes_dir(dir)?;
    for entry in std::fs::read_dir(&d)?.flatten() {
        // forget codes nobody used
        if entry.metadata().ok().and_then(|m| age(&m)).is_none_or(|a| a >= CODE_LIFE) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let code = random_hex();
    create_new(&code_file(dir, &code))?;
    Ok(code)
}

pub fn redeem(dir: &Path, code: &str) -> bool {
    if !is_token(code) || codes_dir(dir).is_err() { return false; }
    let file = code_file(dir, code);
    let Ok(meta) = std::fs::symlink_metadata(&file) else { return false };
    if std::fs::remove_file(&file).is_err() { return false; } // someone else redeemed it first
    meta.is_file() && owned_by_me(&meta) && age(&meta).is_some_and(|a| a < CODE_LIFE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn keys_are_made_once_kept_private_and_the_hook_key_is_a_curl_header_line() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("office-auth-{}-{}", std::process::id(), crate::store::now_ms())).join("data");
        let first = credentials(&dir).unwrap();
        assert!(is_token(&first.ui) && is_token(&first.hook) && first.ui != first.hook);
        let again = credentials(&dir).unwrap();
        assert_eq!((again.ui, again.hook), (first.ui.clone(), first.hook.clone()));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&dir.join("ui-token")), mode(&dir.join("hook-token")), mode(&dir)), (0o600, 0o600, 0o700));
        assert_eq!(std::fs::read_to_string(dir.join("hook-token")).unwrap(), format!("X-Agent-Office-Token: {}\n", first.hook));
        std::fs::set_permissions(dir.join("ui-token"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(secret(&dir, "ui-token").unwrap(), first.ui);
        assert_eq!(mode(&dir.join("ui-token")), 0o600);
        std::fs::write(dir.join("ui-token"), "garbage").unwrap();
        assert_ne!(secret(&dir, "ui-token").unwrap(), first.ui);
        std::fs::remove_file(dir.join("ui-token")).unwrap();
        std::os::unix::fs::symlink(dir.join("hook-token"), dir.join("ui-token")).unwrap();
        assert!(secret(&dir, "ui-token").is_err(), "a symlinked key file is not followed");
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn host_must_name_this_office_and_origin_must_be_the_office_itself() {
        for h in ["localhost:4747", "127.0.0.1:4747", "[::1]:4747", "192.168.1.20:4747", "LOCALHOST:4747"] {
            assert!(host_ok(Some(h), 4747, &[]), "{h}");
        }
        for h in ["", "evil.example:4747", "localhost.evil.example:4747", "localhost:4748", "localhost", "127.0.0.1:4747:1", "a b:4747", "localhost:4747/x", "[zz]:4747", "localhost:"] {
            assert!(!host_ok(Some(h), 4747, &[]), "{h}");
        }
        assert!(!host_ok(None, 4747, &[]));
        assert!(host_ok(Some("my-mac.local:4747"), 4747, &["my-mac.local".into()]));
        assert!(origin_ok(None, Some("localhost:4747")));
        assert!(origin_ok(Some("http://localhost:4747"), Some("localhost:4747")));
        for o in ["http://localhost:5000", "http://evil.example", "null", "https://localhost:4747", "http://127.0.0.1:4747"] {
            assert!(!origin_ok(Some(o), Some("localhost:4747")), "{o}");
        }
    }

    #[test]
    fn keys_compare_exactly_and_launch_codes_work_once() {
        assert!(same(Some("abc"), "abc"));
        assert!(!same(Some("abd"), "abc") && !same(Some("ab"), "abc") && !same(None, "abc"));
        assert_eq!(bearer(Some("Bearer k1")), Some("k1"));
        assert_eq!(bearer(Some("Basic k1")), None);
        assert_eq!(ws_token(Some("agent-office, agent-office.token.k1")), Some("k1"));
        assert_eq!(ws_token(Some("agent-office")), None);
    }

    #[test]
    fn launch_codes_are_files_any_office_can_redeem_once_within_a_minute() {
        let dir = std::env::temp_dir().join(format!("office-codes-{}-{}", std::process::id(), random_hex())).join("data");
        let code = launch_code(&dir).unwrap();
        assert!(!redeem(&dir, "nope") && !redeem(&dir, &"0".repeat(64)));
        assert!(redeem(&dir, &code));
        assert!(!redeem(&dir, &code), "a code works once");
        // The file format bridge/auth.js reads: the name is the code's SHA-256 (a fixed vector both test suites check).
        assert_eq!(code_file(Path::new("/d"), &"ab".repeat(32)), Path::new("/d/login-codes/271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("login-codes")).unwrap().permissions().mode() & 0o777, 0o700);
            let stale = launch_code(&dir).unwrap();
            let old = SystemTime::now() - Duration::from_secs(120);
            std::fs::File::options().write(true).open(code_file(&dir, &stale)).unwrap().set_modified(old).unwrap();
            assert!(!redeem(&dir, &stale), "an expired code is refused");
            let linked = random_hex();
            std::os::unix::fs::symlink(dir.join("ui-token"), code_file(&dir, &linked)).unwrap();
            assert!(!redeem(&dir, &linked), "a symlink is not a code");
        }
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
