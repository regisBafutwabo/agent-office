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

/// <id>/<file> (already percent-decoded) → the file on disk, or None when it would leave the packs folder.
pub fn file(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    let mut parts = 0;
    for c in rel.components() {
        match c {
            Component::Normal(_) => parts += 1,
            _ => return None,
        }
    }
    (parts >= 2).then(|| dir.join(rel))
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
    fn pack_files_stay_inside_the_packs_folder() {
        let dir = Path::new("/data/packs");
        assert_eq!(file(dir, "kenney/chair.glb"), Some(dir.join("kenney/chair.glb")));
        assert_eq!(file(dir, "kenney/Textures/colormap.png"), Some(dir.join("kenney/Textures/colormap.png")));
        assert_eq!(file(dir, "../secret.txt"), None);
        assert_eq!(file(dir, "kenney/../../etc/passwd"), None);
        assert_eq!(file(dir, "/etc/passwd"), None);
        assert_eq!(file(dir, "pack.json"), None);
    }
}
