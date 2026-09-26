// Translate other coding agents' hook payloads into the Claude Code shape that store.rs understands.
// Mirrors bridge/adapters.js; event and field names come from each vendor's docs (checked 2026-09-27,
// see docs/adapters.md). "unverified" marks best guesses where the docs didn't show the exact field.
use serde_json::{Map, Value};

const CLAUDE_EVENTS: [&str; 12] = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "Notification", "Stop", "SubagentStart", "SubagentStop", "PreCompact"];

pub fn claude_tool(name: &str) -> String {
    if name.is_empty() || name.starts_with("mcp__") {
        return name.into();
    }
    let mapped = match name.to_lowercase().as_str() {
        "bash" | "shell" | "run_shell_command" | "run_terminal_cmd" | "execute_command" | "terminal" => "Bash",
        "read" | "read_file" | "view" | "read_many_files" => "Read",
        "write" | "write_file" | "create" | "write_to_file" => "Write",
        "edit" | "edit_file" | "replace" | "str_replace" | "apply_patch" | "search_replace" | "replace_in_file" => "Edit",
        "grep" | "search_file_content" | "search_files" | "codebase_search" => "Grep",
        "glob" | "list_directory" | "list_files" | "file_search" | "ls" => "Glob",
        "web_fetch" | "fetch" => "WebFetch",
        "google_web_search" | "web_search" => "WebSearch",
        "task" | "agent" | "subagent" => "Task",
        _ => return name.into(),
    };
    mapped.into()
}

fn missing(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).map_or(true, Value::is_null)
}

/// First present, non-null value among `keys`.
fn first<'a>(o: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| o.get(*k)).find(|v| !v.is_null())
}

/// The file named in a Codex `apply_patch` body ("*** Update File: path").
fn patched_file(text: &str) -> Option<String> {
    ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|marker| {
        text.find(marker).map(|i| text[i + marker.len()..].lines().next().unwrap_or("").trim().to_string())
    }).filter(|s| !s.is_empty())
}

/// Map common argument names onto Claude's (command, file_path, pattern, url, query).
pub fn claude_input(tool: &str, input: &Value) -> Value {
    let parsed;
    let input = match input {
        Value::String(s) => { parsed = serde_json::from_str::<Value>(s).unwrap_or_else(|_| serde_json::json!({ "command": s })); &parsed }
        other => other,
    };
    let src = input.as_object().cloned().unwrap_or_default();
    let mut out = src.clone();
    let mut fill = |key: &str, keys: &[&str]| {
        if missing(&out, key) {
            if let Some(v) = first(&src, keys) { out.insert(key.into(), v.clone()); }
        }
    };
    fill("command", &["cmd", "command_line"]);
    if tool == "Grep" || tool == "Glob" { fill("file_path", &["absolute_path", "target_file", "filePath"]); } else { fill("file_path", &["absolute_path", "target_file", "filePath", "path"]); }
    if tool == "Grep" || tool == "Glob" { fill("pattern", &["query", "regex", "glob"]); }
    if tool == "WebSearch" { fill("query", &["q", "search_term"]); }
    if tool == "Edit" && missing(&out, "file_path") {
        let text = first(&src, &["input", "patch", "command"]).and_then(Value::as_str).unwrap_or("");
        if let Some(f) = patched_file(text) { out.insert("file_path".into(), f.into()); }
    }
    Value::Object(out)
}

fn lc_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn str_of<'a>(p: &'a Value, k: &str) -> &'a str {
    p.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Rename the event, add extra fields (non-null ones only) and normalize the tool; None means "don't show".
fn reshape(p: &Value, name: Option<&str>, extra: Vec<(&str, Value)>) -> Option<Value> {
    let name = name?;
    let mut out = p.as_object().cloned().unwrap_or_default();
    for (k, v) in extra {
        if !v.is_null() { out.insert(k.into(), v); }
    }
    out.insert("hook_event_name".into(), name.into());
    let tool = out.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
    if !tool.is_empty() {
        let t = claude_tool(&tool);
        let input = claude_input(&t, out.get("tool_input").unwrap_or(&Value::Null));
        out.insert("tool_name".into(), t.into());
        out.insert("tool_input".into(), input);
    }
    Some(Value::Object(out))
}

fn claude_like(p: &Value, renames: &[(&str, &str)]) -> Option<Value> {
    let n = str_of(p, "hook_event_name");
    let name = renames.iter().find(|(from, _)| *from == n).map(|(_, to)| *to).or_else(|| CLAUDE_EVENTS.iter().copied().find(|e| *e == n));
    reshape(p, name, vec![])
}

fn map_name<'a>(table: &[(&str, &'a str)], n: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == n).map(|(_, v)| *v)
}

fn adapt(agent: &str, p: &Value, event: Option<&str>) -> Option<Value> {
    match agent {
        "claude-code" => Some(p.clone()),
        "codex" => claude_like(p, &[("Interrupt", "Stop")]),
        "gemini" => {
            let name = map_name(&[("BeforeAgent", "UserPromptSubmit"), ("AfterAgent", "Stop"), ("BeforeTool", "PreToolUse"), ("AfterTool", "PostToolUse"),
                ("PreCompress", "PreCompact"), ("SessionStart", "SessionStart"), ("SessionEnd", "SessionEnd"), ("Notification", "Notification")], str_of(p, "hook_event_name"));
            let mut out = reshape(p, name, vec![])?;       // BeforeModel/AfterModel are too chatty to show
            if name == Some("Notification") && str_of(p, "notification_type") == "ToolPermission" {
                out["notification_type"] = "permission_prompt".into();
            }
            Some(out)
        }
        "cursor" => {
            let name = map_name(&[("sessionStart", "SessionStart"), ("sessionEnd", "SessionEnd"), ("beforeSubmitPrompt", "UserPromptSubmit"), ("preToolUse", "PreToolUse"),
                ("postToolUse", "PostToolUse"), ("postToolUseFailure", "PostToolUseFailure"), ("subagentStart", "SubagentStart"), ("subagentStop", "SubagentStop"),
                ("preCompact", "PreCompact"), ("stop", "Stop")], str_of(p, "hook_event_name"));
            let sub = name.is_some_and(|n| n.starts_with("Subagent"));
            let parent = str_of(p, "parent_conversation_id");
            let sid = if sub && !parent.is_empty() { parent } else if !str_of(p, "conversation_id").is_empty() { str_of(p, "conversation_id") } else { str_of(p, "session_id") };
            let cwd = if !str_of(p, "cwd").is_empty() { str_of(p, "cwd") } else { p.get("workspace_roots").and_then(|r| r.get(0)).and_then(Value::as_str).unwrap_or("") };
            let mut extra = vec![("session_id", Value::from(sid)), ("cwd", Value::from(cwd))];
            if !str_of(p, "subagent_id").is_empty() {
                let kind = if str_of(p, "subagent_type").is_empty() { "subagent" } else { str_of(p, "subagent_type") };
                extra.push(("agent_id", p["subagent_id"].clone()));
                extra.push(("agent_type", kind.into()));
            }
            reshape(p, name, extra)
        }
        // Copilot CLI payloads don't name the event, so hook.sh passes it as the second argument.
        "copilot" => {
            let n = [str_of(p, "hook_event_name"), str_of(p, "hookEventName"), event.unwrap_or("")].into_iter().find(|s| !s.is_empty()).unwrap_or("");
            let name = map_name(&[("sessionStart", "SessionStart"), ("sessionEnd", "SessionEnd"), ("userPromptSubmitted", "UserPromptSubmit"), ("preToolUse", "PreToolUse"),
                ("postToolUse", "PostToolUse"), ("postToolUseFailure", "PostToolUseFailure"), ("agentStop", "Stop"), ("subagentStart", "SubagentStart"),
                ("subagentStop", "SubagentStop"), ("preCompact", "PreCompact"), ("notification", "Notification"), ("permissionRequest", "PermissionRequest")], &lc_first(n));
            let o = p.as_object().cloned().unwrap_or_default();
            reshape(p, name, vec![
                ("session_id", first(&o, &["sessionId", "session_id"]).cloned().unwrap_or(Value::Null)),
                ("tool_name", first(&o, &["toolName", "tool_name"]).cloned().unwrap_or(Value::Null)),
                ("tool_input", first(&o, &["toolArgs", "tool_input"]).cloned().unwrap_or(Value::Null)),
            ])
        }
        "goose" => {
            let n = if str_of(p, "hook_event_name").is_empty() { str_of(p, "event") } else { str_of(p, "hook_event_name") };
            let o = p.as_object().cloned().unwrap_or_default();
            reshape(p, CLAUDE_EVENTS.iter().copied().find(|e| *e == n), vec![
                ("cwd", first(&o, &["cwd", "working_dir"]).cloned().unwrap_or(Value::Null)),
                ("prompt", first(&o, &["prompt", "message"]).cloned().unwrap_or(Value::Null)),
            ])
        }
        "kiro" => {                                               // exact trigger strings unverified
            let name = map_name(&[("promptsubmit", "UserPromptSubmit"), ("agentstop", "Stop"), ("sessionstart", "SessionStart"), ("agentspawn", "SessionStart"),
                ("pretooluse", "PreToolUse"), ("posttooluse", "PostToolUse")], &str_of(p, "hook_event_name").to_lowercase());
            reshape(p, name, vec![])
        }
        "windsurf" => {                                           // tool_info sub-fields unverified
            let t = p.get("tool_info").cloned().unwrap_or(Value::Null);
            let mcp = format!("mcp__{}__{}", str_of(&t, "mcp_server_name"), str_of(&t, "mcp_tool_name"));
            let (name, tool): (Option<&str>, Option<String>) = match str_of(p, "agent_action_name") {
                "pre_user_prompt" => (Some("UserPromptSubmit"), None), "post_cascade_response" => (Some("Stop"), None),
                "pre_run_command" => (Some("PreToolUse"), Some("Bash".into())), "post_run_command" => (Some("PostToolUse"), Some("Bash".into())),
                "pre_read_code" => (Some("PreToolUse"), Some("Read".into())), "post_read_code" => (Some("PostToolUse"), Some("Read".into())),
                "pre_write_code" => (Some("PreToolUse"), Some("Edit".into())), "post_write_code" => (Some("PostToolUse"), Some("Edit".into())),
                "pre_mcp_tool_use" => (Some("PreToolUse"), Some(mcp)), "post_mcp_tool_use" => (Some("PostToolUse"), Some(mcp)),
                _ => (None, None),
            };
            let input = if tool.is_some() { serde_json::json!({ "command": t.get("command_line"), "file_path": t.get("file_path") }) } else { Value::Null };
            reshape(p, name, vec![("session_id", p.get("trajectory_id").cloned().unwrap_or(Value::Null)), ("cwd", Value::from(str_of(&t, "cwd"))),
                ("prompt", t.get("user_prompt").cloned().unwrap_or(Value::Null)), ("tool_name", tool.map(Value::from).unwrap_or(Value::Null)), ("tool_input", input)])
        }
        "cline" => {                                              // payload nesting unverified: accept flat and per-hook objects
            let hook = str_of(p, "hookName");
            let d = p.get(lc_first(hook)).filter(|v| v.is_object()).unwrap_or(p);
            let name = map_name(&[("TaskStart", "SessionStart"), ("TaskResume", "SessionStart"), ("TaskCancel", "Stop"), ("TaskComplete", "Stop"),
                ("UserPromptSubmit", "UserPromptSubmit"), ("PreToolUse", "PreToolUse"), ("PostToolUse", "PostToolUse")], hook);
            let cwd = p.get("workspaceRoots").and_then(|r| r.get(0)).and_then(Value::as_str).unwrap_or("");
            reshape(p, name, vec![("session_id", p.get("taskId").cloned().unwrap_or(Value::Null)), ("cwd", Value::from(cwd)),
                ("prompt", d.get("prompt").cloned().unwrap_or(Value::Null)), ("tool_name", d.get("toolName").cloned().unwrap_or(Value::Null)),
                ("tool_input", d.get("parameters").cloned().unwrap_or(Value::Null)),
                ("source", if hook == "TaskResume" { "resume".into() } else { Value::Null })])
        }
        // Qwen Code, Factory Droid, and the OpenCode/Amp plugins already send Claude-shaped events; unknown tools are treated the same way.
        _ => claude_like(p, &[]),
    }
}

/// Returns a Claude-shaped payload with a namespaced session id, or None to ignore the event.
pub fn normalize(agent: &str, payload: &Value, event: Option<&str>) -> Option<Value> {
    let mut out = adapt(agent, payload, event)?;
    let sid = out.get("session_id").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string()))).unwrap_or_default();
    if sid.is_empty() {
        return None;
    }
    if agent != "claude-code" {
        out["session_id"] = format!("{agent}:{sid}").into();     // no collisions between tools
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn passes_claude_code_through() {
        let p = json!({ "hook_event_name": "Stop", "session_id": "s1", "cwd": "/x" });
        assert_eq!(normalize("claude-code", &p, None).unwrap(), p);
    }

    #[test]
    fn maps_tool_names_onto_claude_tools() {
        assert_eq!(claude_tool("run_shell_command"), "Bash");
        assert_eq!(claude_tool("apply_patch"), "Edit");
        assert_eq!(claude_tool("mcp__github__create_issue"), "mcp__github__create_issue");
    }

    #[test]
    fn codex_apply_patch_becomes_an_edit_of_the_patched_file() {
        let e = normalize("codex", &json!({ "hook_event_name": "PreToolUse", "session_id": "c1", "cwd": "/repo", "tool_name": "apply_patch",
            "tool_input": { "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@" } }), None).unwrap();
        assert_eq!((e["session_id"].as_str(), e["tool_name"].as_str(), e["tool_input"]["file_path"].as_str()), (Some("codex:c1"), Some("Edit"), Some("src/app.ts")));
        assert_eq!(normalize("codex", &json!({ "hook_event_name": "Interrupt", "session_id": "c1" }), None).unwrap()["hook_event_name"], "Stop");
    }

    #[test]
    fn gemini_events_and_tool_permission_notifications() {
        let pre = normalize("gemini", &json!({ "hook_event_name": "BeforeTool", "session_id": "g1", "tool_name": "run_shell_command", "tool_input": { "command": "npm test" } }), None).unwrap();
        assert_eq!((pre["hook_event_name"].as_str(), pre["tool_name"].as_str(), pre["tool_input"]["command"].as_str()), (Some("PreToolUse"), Some("Bash"), Some("npm test")));
        assert_eq!(normalize("gemini", &json!({ "hook_event_name": "Notification", "session_id": "g1", "notification_type": "ToolPermission" }), None).unwrap()["notification_type"], "permission_prompt");
        assert!(normalize("gemini", &json!({ "hook_event_name": "BeforeModel", "session_id": "g1" }), None).is_none());
    }

    #[test]
    fn cursor_conversation_id_workspace_root_and_subagents() {
        let start = normalize("cursor", &json!({ "hook_event_name": "sessionStart", "conversation_id": "k1", "workspace_roots": ["/Users/me/shop"] }), None).unwrap();
        assert_eq!((start["hook_event_name"].as_str(), start["session_id"].as_str(), start["cwd"].as_str()), (Some("SessionStart"), Some("cursor:k1"), Some("/Users/me/shop")));
        let sub = normalize("cursor", &json!({ "hook_event_name": "subagentStart", "conversation_id": "k2", "parent_conversation_id": "k1", "subagent_id": "sa", "subagent_type": "explore" }), None).unwrap();
        assert_eq!((sub["session_id"].as_str(), sub["agent_id"].as_str(), sub["agent_type"].as_str()), (Some("cursor:k1"), Some("sa"), Some("explore")));
    }

    #[test]
    fn copilot_event_from_hook_script_and_json_string_args() {
        let e = normalize("copilot", &json!({ "sessionId": "p1", "toolName": "bash", "toolArgs": "{\"command\":\"ls\"}" }), Some("preToolUse")).unwrap();
        assert_eq!((e["hook_event_name"].as_str(), e["session_id"].as_str(), e["tool_name"].as_str(), e["tool_input"]["command"].as_str()), (Some("PreToolUse"), Some("copilot:p1"), Some("Bash"), Some("ls")));
    }
}
