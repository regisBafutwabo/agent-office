// Model packs: folders of glTF models that replace the office's built-in furniture (and later its characters).
// Each pack is <packs>/<id>/pack.json plus the .glb/.gltf files it names, served to the page under /packs/<id>/.
// Same rules as bridge/packs.js.
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

pub fn dir() -> PathBuf {
    std::env::var_os("AGENT_OFFICE_PACKS").map(PathBuf::from).unwrap_or_else(|| crate::setup::support_dir().join("packs"))
}

/// Every folder with a readable pack.json, sorted by name; a broken pack is skipped, never fatal.
pub fn list(dir: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut packs: Vec<Value> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            if id.starts_with('.') {
                return None;
            }
            let meta: Value = serde_json::from_str(&std::fs::read_to_string(e.path().join("pack.json")).ok()?).ok()?;
            let slots = meta.get("slots").filter(|s| s.is_object())?.clone();
            let name = meta.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
            let mut pack = json!({ "id": id, "name": name, "slots": slots });
            if let Some(license) = meta.get("license").and_then(Value::as_str) {
                pack["license"] = json!(license);
            }
            Some(pack)
        })
        .collect();
    packs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    packs
}

/// Packs come from anywhere, so only model and texture files are served, never documents or scripts.
const TYPES: [(&str, &str); 8] = [("glb", "model/gltf-binary"), ("gltf", "model/gltf+json"), ("bin", "application/octet-stream"),
    ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"), ("ktx2", "image/ktx2")];
pub const MAX_FILE: u64 = 64 * 1024 * 1024;

/// <id>/<file> (already percent-decoded) → the file on disk and its type, or None when it isn't a model or texture
/// really inside the packs folder (a symlink out of it included).
pub fn file(dir: &Path, rel: &str) -> Option<(PathBuf, &'static str)> {
    let rel = Path::new(rel);
    let mut parts = 0;
    for c in rel.components() {
        match c {
            Component::Normal(_) => parts += 1,
            _ => return None,
        }
    }
    let ext = rel.extension()?.to_str()?.to_ascii_lowercase();
    let (_, mime) = TYPES.iter().find(|(e, _)| *e == ext)?;
    if parts < 2 { return None; }
    let root = std::fs::canonicalize(dir).ok()?;
    let real = std::fs::canonicalize(dir.join(rel)).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    (real.starts_with(&root) && real != root && meta.is_file() && meta.len() <= MAX_FILE).then_some((real, *mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_packs_with_a_valid_pack_json_sorted_by_name() {
        let dir = std::env::temp_dir().join(format!("agent-office-packs-{}", std::process::id()));
        let add = |id: &str, body: Option<&str>| {
            std::fs::create_dir_all(dir.join(id)).unwrap();
            if let Some(b) = body {
                std::fs::write(dir.join(id).join("pack.json"), b).unwrap();
            }
        };
        add("zed", Some(r#"{ "name": "Zed", "slots": { "sofa": { "model": "sofa.glb" } } }"#));
        add("alpha", Some(r#"{ "name": "Alpha", "license": "CC0", "slots": {} }"#));
        add("broken", Some("{ nope"));
        add("empty", None);
        add("noslots", Some(r#"{ "name": "No slots" }"#));
        let packs = list(&dir);
        let ids: Vec<_> = packs.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["alpha", "zed"]);
        assert_eq!(packs[0]["license"], "CC0");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(list(&dir).is_empty());
    }

    #[test]
    fn pack_files_are_models_or_textures_inside_the_packs_folder_and_never_a_symlink_out() {
        let base = std::env::temp_dir().join(format!("agent-office-packfiles-{}-{}", std::process::id(), crate::store::now_ms()));
        let dir = base.join("packs");
        std::fs::create_dir_all(dir.join("kenney/Textures")).unwrap();
        for f in ["chair.glb", "Textures/colormap.png", "page.html", "icon.svg", "run.js", "pack.json"] {
            std::fs::write(dir.join("kenney").join(f), "x").unwrap();
        }
        std::fs::write(base.join("outside.png"), "AUDIT_FIXTURE_ONLY").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.join("outside.png"), dir.join("kenney/escape.png")).unwrap();
        let real = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(file(&dir, "kenney/chair.glb"), Some((real.join("kenney/chair.glb"), "model/gltf-binary")));
        assert_eq!(file(&dir, "kenney/Textures/colormap.png").map(|f| f.1), Some("image/png"));
        for bad in ["../outside.png", "kenney/../../outside.png", "/etc/passwd", "pack.json", "kenney/page.html", "kenney/icon.svg", "kenney/run.js", "kenney/pack.json", "kenney/escape.png", "kenney/missing.glb"] {
            assert_eq!(file(&dir, bad), None, "{bad}");
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
