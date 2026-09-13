use chrono::{Duration as ChronoDuration, Local, TimeZone, Utc};
use serde_json::{json, Value};
use sidetask_core::{
    domain::*, geometry::*, model::apply_command, store::TaskStore, window::WindowController,
};
use std::{
    fs,
    time::{Duration, Instant},
};

fn instant(value: &str) -> chrono::DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}
fn now() -> chrono::DateTime<Utc> {
    instant("2026-01-05T12:00:00.000Z")
}
fn monitor(scale: f64) -> Monitor {
    Monitor {
        id: "primary".into(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0 * scale,
            height: 1080.0 * scale,
        },
        work_area: Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0 * scale,
            height: 1040.0 * scale,
        },
        scale,
        primary: true,
    }
}
fn controller(expanded: bool) -> WindowController {
    WindowController::new(
        Placement::default(),
        "day".into(),
        vec![monitor(1.0)],
        expanded,
    )
}
fn add(store: &mut TaskStore, input: Value) -> Value {
    store
        .transact("task:add", json!({ "input": input }), now())
        .unwrap()["result"]
        .clone()
}

#[test]
fn commands_match_the_existing_browser_model() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/model-contract.json")).unwrap();
    for case in cases {
        let mut state = validate_state(&case["before"]).unwrap();
        let mut sequence = case["sequence"].as_u64().unwrap();
        let actual = apply_command(
            &mut state,
            case["command"].as_str().unwrap(),
            &case["args"],
            instant(case["now"].as_str().unwrap()),
            &mut || {
                sequence += 1;
                format!("contract-{sequence}")
            },
        )
        .unwrap();
        assert_eq!(
            json!(state),
            case["after"],
            "state after {}",
            case["command"]
        );
        assert_eq!(
            actual.result, case["result"]["result"],
            "result of {}",
            case["command"]
        );
        assert_eq!(
            actual.undo.map(|undo| json!(undo)).unwrap_or(Value::Null),
            case["result"].get("undo").cloned().unwrap_or(Value::Null)
        );
    }
}

#[test]
fn validates_calendar_types_references_and_utf16_limits() {
    for invalid in [
        "2026-02-29",
        "2026-9-01",
        "2026-13-01",
        "1899-12-31",
        "not-a-date",
    ] {
        assert!(date(invalid).is_err());
    }
    assert!(date("2028-02-29").is_ok());
    assert!(create_task(&json!({ "title": "📝".repeat(81) }), now(), "id".into()).is_err());
    assert!(create_task(&json!({ "title": "📝".repeat(80) }), now(), "id".into()).is_ok());
    let mut task = create_task(&json!({ "title": " x " }), now(), "id".into()).unwrap();
    assert_eq!(task.title, "x");
    assert!(patch_task(&task, &json!({"completed": 1}), now()).is_err());
    assert!(patch_task(
        &task,
        &json!({"dueDate": "2026-01-01", "dueTime": "25:00"}),
        now()
    )
    .is_err());
    task.category_id = Some("missing".into());
    assert!(assert_references(&task, &State::default()).is_err());
    assert!(validate_settings(&json!({"autoCollapse": "yes"}), &Settings::default()).is_err());
    assert!(validate_settings(
        &json!({"windowPlacement": {"mode":"floating"}}),
        &Settings::default()
    )
    .is_err());
}

#[test]
fn handle_opacity_validates_numeric_bounds_and_defaults_older_settings() {
    for value in [0.2, 0.35, 0.8, 1.0] {
        let settings = validate_settings(
            &json!({"collapsedHandleOpacity": value}),
            &Settings::default(),
        )
        .unwrap();
        assert_eq!(settings.collapsed_handle_opacity, value);
    }
    for value in [
        json!(0),
        json!(0.19),
        json!(1.01),
        json!("0.5"),
        Value::Null,
        json!(true),
    ] {
        assert!(validate_settings(
            &json!({"collapsedHandleOpacity": value}),
            &Settings::default()
        )
        .is_err());
    }
    let mut old = json!(State::default());
    old["settings"]
        .as_object_mut()
        .unwrap()
        .remove("collapsedHandleOpacity");
    assert_eq!(
        validate_state(&old)
            .unwrap()
            .settings
            .collapsed_handle_opacity,
        0.8
    );
}

#[test]
fn monthly_recurrence_and_skipped_cycles_use_local_calendar_dates() {
    let mut task = create_task(
        &json!({ "title": "月末", "dueDate": "2026-01-31", "recurrence": {"frequency":"monthly"} }),
        now(),
        "monthly".into(),
    )
    .unwrap();
    let completed = Local
        .with_ymd_and_hms(2026, 2, 28, 12, 0, 0)
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(
        next_repeat_date(&task, now()).as_deref(),
        Some("2026-02-28")
    );
    task.due_date = Some("2026-02-28".into());
    assert_eq!(
        next_repeat_date(&task, completed).as_deref(),
        Some("2026-03-31")
    );
    let daily = create_task(
        &json!({"title":"每日", "dueDate":"2026-01-06", "recurrence":{"frequency":"daily"}}),
        now(),
        "daily".into(),
    )
    .unwrap();
    assert_eq!(
        next_repeat_date(&daily, completed).as_deref(),
        Some("2026-03-01")
    );
    task.due_date = Some("9999-12-31".into());
    assert_eq!(next_repeat_date(&task, now()), None);
}

#[test]
fn local_reminders_deduplicate_and_recheck_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let task = add(
        &mut store,
        json!({"title":"提醒", "dueDate":"2026-06-01", "dueTime":"11:00", "reminder":{"offsetMinutes":15}}),
    );
    let parsed: Task = serde_json::from_value(task.clone()).unwrap();
    let time = Local
        .with_ymd_and_hms(2026, 6, 1, 10, 45, 0)
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(reminder_at(&parsed), Some(time));
    assert!(store
        .due_entries(time - ChronoDuration::seconds(1))
        .is_empty());
    let entries = store.due_entries(time);
    assert_eq!(entries.len(), 1);
    let response = store
        .transact("reminders:claim", json!({"entries": entries}), time)
        .unwrap();
    assert_eq!(response["result"].as_array().unwrap().len(), 1);
    assert!(TaskStore::open(dir.path())
        .unwrap()
        .due_entries(time + ChronoDuration::hours(1))
        .is_empty());
    store
        .transact(
            "task:update",
            json!({"id":task["id"], "patch":{"dueDate":"2026-06-02"}}),
            time,
        )
        .unwrap();
    assert!(store
        .transact("reminders:claim", json!({"entries": entries}), time)
        .unwrap()["result"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn persistent_writes_reopen_and_failed_writes_leave_the_previous_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    add(&mut store, json!({"title":"已有任务"}));
    store
        .transact(
            "settings:set",
            json!({"patch":{"collapsedHandleOpacity":0.35}}),
            now(),
        )
        .unwrap();
    let before = fs::read(dir.path().join("tasks.json")).unwrap();
    fs::create_dir(dir.path().join("tasks.json.tmp")).unwrap();
    assert!(store
        .transact("task:add", json!({"input":{"title":"失败草稿"}}), now())
        .is_err());
    assert!(store
        .transact(
            "settings:set",
            json!({"patch":{"collapsedHandleOpacity":0.5}}),
            now()
        )
        .is_err());
    assert_eq!(store.snapshot().settings.collapsed_handle_opacity, 0.35);
    assert_eq!(store.snapshot().tasks.len(), 1);
    assert_eq!(fs::read(dir.path().join("tasks.json")).unwrap(), before);
    fs::remove_dir(dir.path().join("tasks.json.tmp")).unwrap();
    add(&mut store, json!({"title":"重试成功"}));
    assert_eq!(
        TaskStore::open(dir.path()).unwrap().snapshot(),
        store.snapshot()
    );
}

#[test]
fn legacy_and_pre_tauri_backups_are_never_overwritten() {
    for version in [1, 2, 3] {
        let dir = tempfile::tempdir().unwrap();
        let mut state = json!(State::default());
        state["version"] = json!(version);
        state["settings"] = json!({"dockSide":"left", "autoCollapse":false});
        state["tasks"] =
            json!([create_task(&json!({"title":"旧数据"}), now(), "legacy".into()).unwrap()]);
        let raw = serde_json::to_vec(&state).unwrap();
        fs::write(dir.path().join("tasks.json"), &raw).unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        assert_eq!(store.snapshot().version, 3);
        assert_eq!(store.snapshot().tasks[0].id, "legacy");
        assert_eq!(store.snapshot().settings.window_placement.edge, "left");
        add(&mut store, json!({"title":"新增"}));
        drop(TaskStore::open(dir.path()).unwrap());
        assert_eq!(
            fs::read(dir.path().join("tasks.pre-tauri.json")).unwrap(),
            raw
        );
        if version < 3 {
            assert_eq!(
                fs::read(dir.path().join(format!("tasks.v{version}-original.json"))).unwrap(),
                raw
            );
        }
    }
}

#[test]
fn future_versions_are_refused_and_corrupt_data_is_preserved_before_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tasks.json");
    fs::write(&file, br#"{"version":4,"tasks":[]}"#).unwrap();
    assert!(TaskStore::open(dir.path()).is_err());
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "{\"version\":4,\"tasks\":[]}"
    );
    fs::remove_file(&file).unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    add(&mut store, json!({"title":"备份中的任务"}));
    add(&mut store, json!({"title":"最近的任务"}));
    fs::write(&file, b"broken").unwrap();
    let recovered = TaskStore::open(dir.path()).unwrap();
    assert_eq!(recovered.snapshot().tasks[0].title, "备份中的任务");
    assert_eq!(recovered.snapshot().tasks.len(), 1);
    assert!(fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("tasks.corrupt-")));
}

#[test]
fn undo_and_optimistic_updates_remain_transactional() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let task = add(
        &mut store,
        json!({"title":"循环", "dueDate":"2026-01-31", "recurrence":{"frequency":"daily"}}),
    );
    let completed = store.transact("task:update", json!({"id":task["id"], "patch":{"completed":true}, "expectedUpdatedAt":task["updatedAt"]}), now()).unwrap();
    assert_eq!(store.snapshot().tasks.len(), 2);
    assert!(store.transact("task:update", json!({"id":task["id"], "patch":{"title":"过期修改"}, "expectedUpdatedAt":task["updatedAt"]}), now()).is_err());
    assert!(store
        .transact("task:undo", json!({"token":"fabricated"}), now())
        .is_err());
    store
        .transact("task:undo", json!({"token":completed["undoToken"]}), now())
        .unwrap();
    assert_eq!(json!(store.snapshot().tasks), json!([task]));
    assert!(store
        .transact("task:undo", json!({"token":completed["undoToken"]}), now())
        .is_err());
    let completed = store
        .transact(
            "task:update",
            json!({"id":task["id"], "patch":{"completed":true}}),
            now(),
        )
        .unwrap();
    assert!(store
        .transact(
            "task:undo",
            json!({"token":completed["undoToken"]}),
            now() + ChronoDuration::seconds(11)
        )
        .is_err());
}

#[test]
fn four_edges_all_views_and_dpi_keep_the_handle_in_the_work_area() {
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let mut monitor = monitor(scale);
        monitor.bounds.x = -monitor.bounds.width;
        monitor.work_area.x = monitor.bounds.x;
        monitor.work_area.y = -80.0;
        for edge in EDGES {
            for view in ["day", "week", "month"] {
                for anchor in [0.0, 0.15, 0.85, 1.0] {
                    let placement = Placement {
                        edge: edge.into(),
                        anchor,
                        ..Placement::default()
                    };
                    let layout = layout(&monitor, &placement, view, None);
                    assert_eq!(layout.handle.width, 40.0 * scale);
                    assert_eq!(layout.handle.height, 40.0 * scale);
                    for rect in [layout.full, layout.handle] {
                        assert!(rect.x >= monitor.work_area.x && rect.y >= monitor.work_area.y);
                        assert!(
                            rect.x + rect.width
                                <= monitor.work_area.x + monitor.work_area.width + 0.5
                        );
                        assert!(
                            rect.y + rect.height
                                <= monitor.work_area.y + monitor.work_area.height + 0.5
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn native_coordinates_choose_monitors_without_scaling_the_global_origin_twice() {
    let primary = monitor(1.0);
    let mut secondary = monitor(1.5);
    secondary.id = "secondary".into();
    secondary.primary = false;
    secondary.bounds.x = 1920.0;
    secondary.work_area.x = 1920.0;
    let displays = vec![primary, secondary];
    assert_eq!(
        display_for_bounds(
            &displays,
            Rect {
                x: 2000.0,
                y: 100.0,
                width: 60.0,
                height: 60.0
            },
            "primary"
        ),
        1
    );
    let mut window = WindowController::new(Placement::default(), "day".into(), displays, false);
    window.start_drag().unwrap();
    window.end_drag(
        Rect {
            x: 2400.0,
            y: 0.0,
            width: 60.0,
            height: 60.0,
        },
        Instant::now(),
    );
    assert!(!window.expanded);
    assert_eq!(window.placement.edge, "top");
    assert_eq!(window.current_monitor().id, "secondary");
    assert_eq!(window.bounds.width, 60.0);
    assert_eq!(window.bounds.x, 2400.0);
}

#[test]
fn auto_collapse_has_no_delay_and_protection_release_is_immediate() {
    let now = Instant::now();
    let mut window = controller(true);
    window.focus(false, now);
    assert_eq!(window.phase, "collapsing");
    window.focus(true, now);
    assert_eq!(window.phase, "expanding");
    window.finish(window.transition_id);
    window.protect(true, now);
    window.focus(false, now);
    assert_eq!(window.phase, "expanded");
    window.protect(false, now);
    assert_eq!(window.phase, "collapsing");
    window.finish(window.transition_id);
    window.focus(true, now);
    assert!(
        !window.expanded,
        "focusing a settled handle must not expand it during drag"
    );
}

#[test]
fn collapsed_drag_snaps_after_release_and_does_not_expand() {
    let mut window = controller(false);
    let now = Instant::now();
    for (edge, bounds) in [
        (
            "left",
            Rect {
                x: 10.0,
                y: 320.0,
                width: 40.0,
                height: 40.0,
            },
        ),
        (
            "top",
            Rect {
                x: 500.0,
                y: 8.0,
                width: 40.0,
                height: 40.0,
            },
        ),
        (
            "right",
            Rect {
                x: 1870.0,
                y: 500.0,
                width: 40.0,
                height: 40.0,
            },
        ),
        (
            "bottom",
            Rect {
                x: 600.0,
                y: 990.0,
                width: 40.0,
                height: 40.0,
            },
        ),
    ] {
        window.start_drag().unwrap();
        window.moved(bounds);
        assert!(window.dragging);
        window.end_drag(bounds, now);
        assert!(!window.expanded && !window.dragging);
        assert_eq!(window.placement.edge, edge);
        assert_eq!(window.bounds, window.layout().handle);
    }
}

#[test]
fn animation_acknowledgments_reversals_and_timeout_preserve_the_latest_target() {
    let now = Instant::now();
    let mut window = controller(false);
    for _ in 0..20 {
        window.expand(now);
        let old = window.transition_id;
        window.finish(old);
        assert_eq!(window.stage, "prepare");
        assert_eq!(window.bounds.width, 40.0);
        window.collapse(false, now);
        window.ready(old);
        window.finish(old);
        assert!(!window.expanded);
        window.finish(window.transition_id);
        assert_eq!(window.bounds.width, 40.0);
    }
    window.expand(now);
    window.tick(now + Duration::from_millis(801));
    assert!(window.expanded && window.surface_expanded);
    assert_eq!(window.phase, "expanded");
    assert_eq!(window.bounds.width, 420.0);
}

#[test]
fn interrupted_opening_can_reopen_and_drag_despite_late_acknowledgements() {
    let now = Instant::now();
    for prepared in [false, true] {
        let mut window = controller(false);
        window.focus(true, now);
        window.expand(now);
        let opening = window.transition_id;
        if prepared {
            window.ready(opening);
        }
        window.focus(false, now);
        let closing = window.transition_id;
        assert_eq!(window.phase, "collapsing");

        window.focus(true, now);
        assert_eq!(window.snapshot()["focusRestored"], true);
        let resumed = window.transition_id;
        // The handle's explicit expand intent must not toggle this focus-driven
        // reversal back to collapsed when its click arrives.
        window.expand(now);
        assert_eq!(window.transition_id, resumed);
        assert_eq!(window.snapshot()["focusRestored"], false);
        window.ready(opening);
        window.finish(opening);
        window.finish(closing);
        assert!(window.expanded);
        window.ready(resumed);
        window.finish(resumed);
        assert!(window.settled());
        assert_eq!(window.bounds, window.layout().full);

        window.focus(false, now);
        // A background renderer may stop acknowledging frames altogether.
        window.tick(now + Duration::from_millis(801));
        assert_eq!(window.phase, "collapsed");
        window.focus(true, now);
        window.start_drag().unwrap();
        window.end_drag(window.bounds, now);
        assert!(window.settled());
        window.expand(now);
        window.ready(window.transition_id);
        window.finish(window.transition_id);
        assert_eq!(window.phase, "expanded");
    }
}

#[test]
fn an_unconfirmed_native_drag_times_out_and_allows_the_next_action() {
    let now = Instant::now();
    let mut window = controller(false);
    window.request_drag(now).unwrap();
    assert!(window.dragging && window.needs_tick());
    assert!(window.request_drag(now).is_err());
    window.tick(now + Duration::from_millis(501));
    assert!(window.settled());
    assert!(!window.dragging && !window.needs_tick());
    assert_eq!(window.bounds, window.layout().handle);
    window.expand(now);
    window.ready(window.transition_id);
    window.finish(window.transition_id);
    assert_eq!(window.phase, "expanded");
}

#[test]
fn a_confirmed_native_drag_waits_for_release_instead_of_timing_out() {
    let now = Instant::now();
    let mut window = controller(false);
    window.request_drag(now).unwrap();
    window.start_drag().unwrap(); // WM_ENTERSIZEMOVE confirms the request.
    window.tick(now + Duration::from_secs(2));
    assert!(window.dragging);
    assert!(!window.needs_tick());
    window.end_drag(window.bounds, now);
    assert!(window.settled());
}

#[test]
fn floating_docking_starts_immediately_and_respects_reduced_motion() {
    let now = Instant::now();
    let mut window = controller(true);
    window.start_drag().unwrap();
    window.end_drag(
        Rect {
            x: 300.0,
            y: 100.0,
            width: 420.0,
            height: 850.0,
        },
        now,
    );
    window.reduced_motion = true;
    window.focus(false, now);
    assert_eq!(window.phase, "collapsing");
    window.finish(window.transition_id);
    assert_eq!(window.bounds.width, 40.0);
    let saved = window.placement.clone();
    window.expand(now);
    window.ready(window.transition_id);
    window.finish(window.transition_id);
    assert_eq!(window.placement, saved);
}
