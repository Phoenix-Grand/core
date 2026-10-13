//! Golden tests: every `tests/golden/*.kbview` compiles against `tests/fixtures/registry.web.json` and its
//! plan, declarations, check file and diagnostics are compared with the committed `.out` snapshot.
//! `UPDATE_GOLDEN=1 cargo test -p kubuno-web-views-compiler-core --test golden` rewrites the snapshots.
//!
//! The fixture registry is a subset of the real `kbview-registry.web.json` (core, `@kubuno/ui`) plus two
//! test-only elements, `Stack` and `Repeater` (`@kubuno/views`), until WV-5a adds the real layout set.

use std::fs;
use std::path::Path;

use kubuno_web_views_compiler_core::registry::UserControlProp;
use kubuno_web_views_compiler_core::{CompileOptions, CompileRequest, RegistryInput, Session, UserControlRef};

fn session() -> Session {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut s = Session::new();
    let json = fs::read_to_string(dir.join("registry.web.json")).expect("fixture registry");
    s.add_registry(&RegistryInput { json, label: "fixtures/registry.web.json".into(), host: true }).expect("registry loads");
    s
}

fn snapshot(name: &str, source: &str, s: &Session) -> String {
    let options = CompileOptions {
        file: format!("src/{name}"),
        code_behind: Some(format!("./{}", name.split('.').next().unwrap_or_default())),
        design: false,
        class_name: None,
    };
    let out = s.compile(&CompileRequest { source: source.to_string(), options });
    let mut text = String::new();
    text.push_str("=== diagnostics\n");
    for d in &out.diagnostics {
        text.push_str(&format!("{}:{}-{}:{} {} [{}] {}\n", d.line, d.column, d.end_line, d.end_column, d.severity, d.code, d.message));
    }
    text.push_str("=== plan\n");
    text.push_str(&serde_json::to_string_pretty(&out.plan).expect("plan serialises"));
    text.push_str("\n=== d.ts\n");
    text.push_str(&out.dts);
    text.push_str("=== check.ts\n");
    text.push_str(&out.check);
    text.push_str("=== check map\n");
    for m in &out.check_map {
        text.push_str(&format!(
            "{}:{}-{} -> {}:{}-{}:{}{} ({})\n",
            m.line,
            m.start,
            m.end,
            m.src[0],
            m.src[1],
            m.src_end[0],
            m.src_end[1],
            if m.exact { " exact" } else { "" },
            m.what
        ));
    }
    text
}

#[test]
fn golden_views() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let s = session();
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();
    let mut names: Vec<_> = fs::read_dir(&dir).expect("golden dir").filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut failures = Vec::new();
    let mut count = 0;
    for name in names.iter().filter(|n| n.ends_with(".kbview") || n.ends_with(".kbcontrol")) {
        count += 1;
        let source = fs::read_to_string(dir.join(name)).expect("view").replace("\r\n", "\n");
        let actual = snapshot(name, &source, &s);
        let out = dir.join(format!("{name}.out"));
        if update {
            fs::write(&out, &actual).expect("write snapshot");
            continue;
        }
        let expected = fs::read_to_string(&out).unwrap_or_default().replace("\r\n", "\n");
        if expected != actual {
            failures.push(name.clone());
            fs::write(dir.join(format!("{name}.actual")), &actual).expect("write actual");
        }
    }
    assert!(count >= 4, "golden views found: {count}");
    assert!(failures.is_empty(), "golden mismatches (see tests/golden/*.actual): {failures:?}");
}

#[test]
fn the_plan_of_a_valid_view_has_no_error() {
    let s = session();
    let source = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/settings.kbview")).expect("view");
    let out = s.compile(&CompileRequest {
        source,
        options: CompileOptions { file: "src/settings.kbview".into(), code_behind: Some("./settings".into()), ..Default::default() },
    });
    assert!(out.ok, "{:?}", out.diagnostics);
    let plan = out.plan.expect("plan");
    assert_eq!(plan.names.get("save").map(String::as_str), Some("0.1.0"));
    assert_eq!(plan.handlers, vec!["cancel_click", "fix_click", "font_changed", "page_load", "save_click"]);
}

#[test]
fn design_builds_keep_design_time_values() {
    let s = session();
    let source = r#"<Stack DesignWidth="400" DesignHeight="300"><Button Text="{Binding name}" d:Text="Sample"/></Stack>"#;
    let out = s.compile(&CompileRequest { source: source.into(), options: CompileOptions { file: "src/d.kbview".into(), design: true, ..Default::default() } });
    let plan = out.plan.expect("plan");
    assert_eq!(plan.design_size, Some([400.0, 300.0]));
    assert_eq!(plan.root.children[0].design.len(), 1);
    let prod = s.compile(&CompileRequest { source: source.into(), options: CompileOptions { file: "src/d.kbview".into(), ..Default::default() } });
    let plan = prod.plan.expect("plan");
    assert!(plan.design_size.is_none());
    assert!(plan.root.children[0].design.is_empty());
}

#[test]
fn module_isolation_rejects_foreign_modules() {
    let mut s = session();
    let foreign = r#"{"schema":1,"target":"web","version":"0","components":[{"name":"NoteCard","children":"None","web":{"module":"@kubuno/notes","export":"NoteCard","dom_root":"ref"}},{"name":"LocalCard","children":"None","web":{"module":"/src/controls","export":"LocalCard","dom_root":"ref"}}]}"#;
    s.add_registry(&RegistryInput { json: foreign.into(), label: "controls.json".into(), host: false }).expect("loads");
    s.set_user_controls(&[
        UserControlRef { name: "MessageRow".into(), module: "/src/MessageRow".into(), props: Vec::new() },
        UserControlRef { name: "Bad".into(), module: "drive/Row".into(), props: Vec::new() },
    ]);
    let out = s.compile(&CompileRequest {
        source: "<Stack><LocalCard/><MessageRow Foo=\"1\"/></Stack>".into(),
        options: CompileOptions { file: "src/v.kbview".into(), ..Default::default() },
    });
    let isolation: Vec<_> = out.diagnostics.iter().filter(|d| d.message.contains("module isolation")).collect();
    assert_eq!(isolation.len(), 2, "{:?}", out.diagnostics);
    assert!(isolation.iter().all(|d| d.severity == "error"));
    assert!(!out.ok);
    let plan = out.plan.expect("plan");
    assert_eq!(plan.root.children[0].m.as_deref(), Some("/src/controls"));
    assert_eq!(plan.root.children[1].kind, Some("user_control"));
    // A host registry may not name a project file either.
    let mut host = Session::new();
    host.add_registry(&RegistryInput { json: foreign.into(), label: "host.json".into(), host: true }).expect("loads");
    assert_eq!(host.registry.problems.len(), 2);
}

#[test]
fn a_typed_user_control_binds_objects_and_wires_events() {
    // WV-7: a `.kbcontrol` whose `x:Props` type was extracted is a typed element. An object field is a
    // bindable property (its binding type-checks as `__any`, not `__str`), a function field is an event.
    let mut s = session();
    s.set_user_controls(&[UserControlRef {
        name: "SearchResultRow".into(),
        module: "/src/SearchResultRow".into(),
        props: vec![
            UserControlProp { name: "file".into(), event: false, kind: Some("object".into()), args: None },
            UserControlProp { name: "count".into(), event: false, kind: Some("number".into()), args: None },
            UserControlProp { name: "onOpen".into(), event: true, kind: None, args: Some("value".into()) },
        ],
    }]);
    let el = s.registry.get("SearchResultRow").expect("the typed user control is registered");
    assert!(el.is_user_control());
    assert_eq!(el.web.prop_map.get("File").and_then(|t| t.prop.as_deref()), Some("file"));
    assert_eq!(el.web.event_map.get("OnOpen").and_then(|e| e.prop.as_deref()), Some("onOpen"));

    let out = s.compile(&CompileRequest {
        source: r#"<Repeater ItemKey="key" ItemsSource="{Binding rows}"><SearchResultRow File="{Binding file}" Count="{Binding n}" OnOpen="open_result"/></Repeater>"#.into(),
        options: CompileOptions { file: "src/v.kbview".into(), code_behind: Some("./v".into()), ..Default::default() },
    });
    assert!(out.ok, "{:?}", out.diagnostics);
    assert!(out.handlers.iter().any(|h| h.name == "open_result"), "the event wires a handler: {:?}", out.handlers);
    // The object binding is checked with `__any` (an object/function binding type-checks); the number with `__num`.
    assert!(out.check.contains("__any("), "object prop → __any: {}", out.check);
    assert!(out.check.contains("__num("), "number prop → __num: {}", out.check);
    let plan = out.plan.expect("plan");
    let json = serde_json::to_string(&plan).expect("plan serialises");
    assert!(json.contains("\"kind\":\"user_control\""), "the control renders as a user_control node: {json}");
    assert!(json.contains("\"prop\":\"file\""), "the object prop maps to this.props.file: {json}");
    assert!(json.contains("\"prop\":\"onOpen\""), "the event maps to this.props.onOpen: {json}");
}

#[test]
fn a_project_control_cannot_shadow_a_host_element() {
    let mut s = session();
    let shadow = r#"{"schema":1,"target":"web","version":"0","components":[{"name":"Button","children":"None","web":{"module":"./mine","export":"Button","dom_root":"ref"}}]}"#;
    s.add_registry(&RegistryInput { json: shadow.into(), label: "controls.json".into(), host: false }).expect("loads");
    assert!(s.registry.problems.iter().any(|p| p.contains("declared twice")));
    assert_eq!(s.registry.get("Button").and_then(|e| e.web.module.clone()).as_deref(), Some("@ui"));
}

#[test]
fn handle_types_cover_every_element() {
    let s = session();
    let text = s.handle_types();
    assert!(text.contains("export interface Button extends ElementHandle {"));
    assert!(text.contains("  variant: \"Primary\" | \"Secondary\" | \"Ghost\" | \"Text\" | \"Danger\" | \"TextDanger\""));
    assert!(text.contains("  enabled: boolean"));
    assert!(!text.contains("stack.Fill"));
    assert!(text.contains("  Button: Button"));
    assert!(!text.contains("interface Repeater"), "runtime elements declare their own handle");
}
