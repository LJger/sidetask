use crate::platform;
use chrono::{Local, Utc};
use serde_json::{json, Value};
use sidetask_core::{
    diagnostics::Diagnostics, domain::*, geometry::*, retry::RetryGate, store::TaskStore,
    window::WindowController, Result,
};
use std::{
    fs,
    io::Write,
    sync::mpsc::{self, Receiver, Sender},
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

type Reply = tauri::async_runtime::Sender<Result<Value>>;

pub enum Op {
    Request {
        command: String,
        args: Value,
        reply: Reply,
    },
    NativeApplied {
        update: platform::NativeUpdate,
        result: Result<bool>,
        elapsed_ms: u64,
    },
    Focus(bool),
    DragBegin,
    Moved(Rect),
    DragEnd(Rect),
    DisplaysChanged,
    Resume,
    Menu(String),
    OpenReminders(Vec<String>),
    NotificationFailed(Vec<String>),
    DialogFinished {
        imported: Option<Value>,
        result: Result<Value>,
        reply: Reply,
    },
    Quit,
}

#[derive(Clone)]
struct Backend(Sender<Op>);

#[tauri::command]
async fn request(
    window: WebviewWindow,
    backend: tauri::State<'_, Backend>,
    command: String,
    args: Value,
) -> Result<Value> {
    if window.label() != "main" || !allowed_url(&window.url().map_err(|_| "请求来源无效。")?)
    {
        return Err("请求来源无效。".into());
    }
    let (reply, mut response) = tauri::async_runtime::channel(1);
    backend
        .0
        .send(Op::Request {
            command,
            args,
            reply,
        })
        .map_err(|_| "侧记正在退出，请稍后重试。")?;
    response.recv().await.ok_or("侧记已退出。")?
}

fn allowed_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        && url.port().is_none()
        && url.path() == "/src/index.html"
}

fn send(app: &AppHandle, op: Op) {
    if let Some(backend) = app.try_state::<Backend>() {
        let _ = backend.0.send(op);
    }
}

struct Runtime {
    app: AppHandle,
    window: WebviewWindow,
    sender: Sender<Op>,
    store: TaskStore,
    windows: WindowController,
    interaction: bool,
    native_dialog: bool,
    frontend_ready: bool,
    shortcut_registered: bool,
    pending_action: Option<Value>,
    early_actions: Vec<Value>,
    published: Value,
    applied_bounds: Option<Rect>,
    applied_region: Option<Option<Rect>>,
    applied_pin: Option<bool>,
    native_inflight: Option<u64>,
    native_sequence: u64,
    pending_show: Option<bool>,
    pending_replies: Vec<(Reply, Result<Value>)>,
    native_error: Option<String>,
    hidden_after_failure: bool,
    pending_count: usize,
    native_retry: RetryGate,
    placement_retry: RetryGate,
    tray_retry: RetryGate,
    last_window_error: Option<(String, Instant)>,
    diagnostics: Diagnostics,
    tray_state: Option<(bool, bool, usize)>,
    notifications: Option<platform::Notifications>,
    notification_error: Option<String>,
    next_reminder: Instant,
    last_reminder: Option<chrono::DateTime<Utc>>,
    catch_up: bool,
    test_mode: bool,
    quitting: bool,
    revision: u64,
}

impl Runtime {
    fn can_launch(&self) -> bool {
        !cfg!(debug_assertions) && !self.test_mode
    }

    fn action(&mut self, action: Value) {
        if self.frontend_ready {
            let _ = self.window.emit("app:action", action);
        } else {
            self.early_actions.push(action);
        }
    }

    fn window_error(&mut self, error: String) {
        let now = Instant::now();
        self.diagnostics
            .record("window-error", json!({"message": error}));
        if self
            .last_window_error
            .as_ref()
            .is_some_and(|(previous, at)| {
                previous == &error && now.duration_since(*at) < Duration::from_secs(30)
            })
        {
            return;
        }
        self.last_window_error = Some((error.clone(), now));
        self.action(json!({ "type": "window-error", "message": error }));
    }

    fn emit_state(&mut self, tasks_changed: bool) {
        self.revision += 1;
        if self.frontend_ready {
            let _ = self.window.emit(
                "state:changed",
                json!({"state": self.store.snapshot(), "revision": self.revision}),
            );
        }
        if tasks_changed {
            self.pending_count = self
                .store
                .snapshot()
                .tasks
                .iter()
                .filter(|task| task.completed_at.is_none())
                .count();
            if let Some(notifications) = &mut self.notifications {
                notifications.reconcile(&self.store.snapshot().tasks);
            }
            self.next_reminder = Instant::now();
        }
    }

    fn commit(&mut self, command: &str, args: Value) -> Result<Value> {
        let response = self.store.transact(command, args, Utc::now())?;
        self.emit_state(command != "settings:set");
        Ok(response)
    }

    fn protect(&mut self) {
        self.windows.protect(
            !self.frontend_ready || self.interaction || self.native_dialog,
            Instant::now(),
        );
    }

    fn expand(&mut self, cursor: bool, action: Option<Value>) {
        if cursor {
            self.windows.at_cursor(platform::cursor());
        }
        if action.is_some() {
            self.pending_action = action;
        }
        self.windows.expand(Instant::now());
        if self.frontend_ready {
            self.pending_show = Some(true);
            self.native_retry.reset();
        }
    }

    fn collapse(&mut self) {
        if self.native_dialog {
            return;
        }
        self.pending_action = None;
        self.windows.collapse(false, Instant::now());
    }

    fn toggle(&mut self, cursor: bool) {
        if self.hidden_after_failure
            || !self.windows.expanded
            || self.windows.snapshot()["docking"] == true
        {
            self.expand(cursor, None);
        } else {
            self.collapse();
        }
    }

    fn save_settings(&mut self, patch: Value) -> Result<Value> {
        let previous = self.store.snapshot().settings.clone();
        let settings = validate_settings(&patch, &previous)?;
        if settings == previous {
            return Ok(json!({"state": self.store.snapshot(), "result": settings}));
        }
        let startup_changed = settings.launch_at_login != previous.launch_at_login;
        if startup_changed {
            if !self.can_launch() {
                return Err("请在 Windows 打包版本中设置开机启动。".into());
            }
            platform::set_startup(settings.launch_at_login)?;
        }
        let response = match self.commit("settings:set", json!({ "patch": patch })) {
            Ok(response) => response,
            Err(error) => {
                if startup_changed {
                    let _ = platform::set_startup(previous.launch_at_login);
                }
                return Err(error);
            }
        };
        if settings.window_placement != previous.window_placement {
            self.windows.relocate(settings.window_placement);
        }
        self.windows.auto_collapse = settings.auto_collapse;
        self.protect();
        Ok(response)
    }

    fn refresh_tray(&mut self) -> Result<()> {
        let pending = self.pending_count;
        let pin = self.store.snapshot().settings.always_on_top;
        let state = (
            self.windows.expanded && !self.hidden_after_failure,
            pin,
            pending,
        );
        if self.tray_state == Some(state) {
            return Ok(());
        }
        let toggle = MenuItem::with_id(
            &self.app,
            "toggle",
            if state.0 {
                "收起侧栏"
            } else {
                "展开侧栏"
            },
            true,
            None::<&str>,
        );
        let add = MenuItem::with_id(&self.app, "add", "添加任务", true, None::<&str>);
        let settings = MenuItem::with_id(&self.app, "settings", "设置", true, None::<&str>);
        let pin_item =
            CheckMenuItem::with_id(&self.app, "pin", "窗口置顶", true, pin, None::<&str>);
        let quit = MenuItem::with_id(&self.app, "quit", "退出侧记", true, None::<&str>);
        let build = || -> tauri::Result<Menu<tauri::Wry>> {
            Menu::with_items(
                &self.app,
                &[
                    &toggle?,
                    &add?,
                    &PredefinedMenuItem::separator(&self.app)?,
                    &pin_item?,
                    &settings?,
                    &PredefinedMenuItem::separator(&self.app)?,
                    &quit?,
                ],
            )
        };
        let menu = build().map_err(|e| e.to_string())?;
        if let Some(tray) = self.app.tray_by_id("sidetask") {
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
            tray.set_tooltip(Some(format!("侧记 · {pending} 件待办")))
                .map_err(|e| e.to_string())?;
        }
        self.tray_state = Some(state);
        Ok(())
    }

    fn sync(&mut self) {
        let now = Instant::now();
        let bounds = self.windows.native_bounds();
        let region = self.windows.native_region();
        let pin = !self.windows.expanded || self.store.snapshot().settings.always_on_top;
        if self.native_inflight.is_none() && self.native_retry.ready(now) {
            let moved = !self.windows.dragging && self.applied_bounds != Some(bounds);
            let clipped = self.applied_region != Some(region);
            let pinned = self.applied_pin != Some(pin);
            if moved || clipped || pinned || self.pending_show.is_some() {
                self.native_sequence += 1;
                let show = self.pending_show.take();
                let update = platform::NativeUpdate {
                    id: self.native_sequence,
                    bounds: moved.then_some(bounds),
                    region: clipped.then_some(region),
                    pin: pinned.then_some(pin),
                    show,
                };
                match platform::queue_update(&self.window, update, self.sender.clone()) {
                    Ok(()) => self.native_inflight = Some(self.native_sequence),
                    Err(error) => {
                        // A rejected queue operation never reaches NativeApplied.
                        // Keep even a show-only request eligible for retry.
                        self.pending_show = show;
                        self.native_error = Some(error.clone());
                        self.native_retry.failed(now);
                        self.window_error(error);
                    }
                }
            }
        }
        if self.tray_retry.ready(now) {
            if let Err(error) = self.refresh_tray() {
                self.tray_retry.failed(now);
                self.window_error(format!("无法更新托盘菜单：{error}"));
            } else {
                self.tray_retry.reset();
            }
        }
        // Publish and resolve geometry-dependent requests only after the UI
        // thread has applied the latest state. Never block its message loop.
        if self.native_inflight.is_some() {
            return;
        }
        if let Some(error) = &self.native_error {
            for (reply, _) in std::mem::take(&mut self.pending_replies) {
                let _ = reply.blocking_send(Err(error.clone()));
            }
            return;
        }
        let state = self.windows.snapshot();
        if state != self.published {
            if self.frontend_ready {
                let _ = self.window.emit("window:changed", &state);
            }
            self.published = state;
        }
        if self.windows.settled() {
            if self.windows.placement != self.store.snapshot().settings.window_placement
                && self.placement_retry.ready(now)
            {
                let args = json!({ "patch": { "windowPlacement": self.windows.placement } });
                if let Err(error) = self.commit("settings:set", args) {
                    self.placement_retry.failed(now);
                    self.window_error(format!("窗口位置未保存：{error}"));
                } else {
                    self.placement_retry.reset();
                }
            }
            if self.windows.expanded && self.frontend_ready {
                if let Some(action) = self.pending_action.take() {
                    self.action(action);
                }
            }
        }
        for (reply, result) in std::mem::take(&mut self.pending_replies) {
            let _ = reply.blocking_send(result.map(|value| self.stamp(value)));
        }
    }

    fn reminders(&mut self) {
        let now = Utc::now();
        let missed = self.catch_up
            || self
                .last_reminder
                .is_some_and(|previous| (now - previous).num_seconds() > 60);
        self.last_reminder = Some(now);
        self.catch_up = false;
        let entries = self.store.due_entries(now);
        let mut failed = false;
        if !entries.is_empty() {
            match self
                .store
                .transact("reminders:claim", json!({ "entries": entries }), now)
            {
                Ok(response) => {
                    self.emit_state(true);
                    let tasks: Vec<Task> =
                        serde_json::from_value(response["result"].clone()).unwrap_or_default();
                    if !tasks.is_empty() {
                        let ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
                        self.action(
                            json!({ "type": "reminder-notice", "taskIds": ids, "missed": missed }),
                        );
                        let native = !self.test_mode
                            || std::env::var("SIDETASK_TEST_NATIVE_NOTIFICATIONS").as_deref()
                                == Ok("1");
                        if self.test_mode {
                            if let Ok(mut output) = fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(self.store.directory.join("test-notifications.jsonl"))
                            {
                                let _ = writeln!(
                                    output,
                                    "{}",
                                    json!({ "taskIds": ids, "missed": missed })
                                );
                            }
                        }
                        if native {
                            let delivery = if let Some(notifications) = &mut self.notifications {
                                notifications.show(&tasks, missed, self.sender.clone())
                            } else {
                                Err(self.notification_error.clone().unwrap_or_else(|| {
                                    "当前系统无法显示桌面通知，到期任务已保留在侧栏提示中。".into()
                                }))
                            };
                            if let Err(error) = delivery {
                                self.action(json!({ "type": "notification-error", "message": error, "taskIds": ids }));
                            }
                        }
                    }
                }
                Err(error) => {
                    failed = true;
                    self.action(json!({ "type": "notification-error", "message": error }));
                }
            }
        }
        self.next_reminder = Instant::now()
            + if failed {
                Duration::from_secs(5)
            } else {
                self.store.next_reminder_delay(now)
            };
    }

    fn start_dialog(&mut self, export: bool, reply: Reply) {
        if self.native_dialog {
            let _ = reply.blocking_send(Err("请先完成当前文件操作。".into()));
            return;
        }
        self.native_dialog = true;
        self.protect();
        let sender = self.sender.clone();
        let window = self.window.clone();
        let directory = self.store.directory.clone();
        let state = self.store.snapshot().clone();
        std::thread::spawn(move || {
            let operation = || -> Result<(Option<Value>, Value)> {
                let picker = rfd::FileDialog::new()
                    .set_parent(&window)
                    .add_filter("侧记备份", &["json"]);
                if export {
                    let file = picker
                        .set_title("导出侧记备份")
                        .set_file_name(format!("SideTask-{}.json", Local::now().format("%Y-%m-%d")))
                        .save_file();
                    let Some(file) = file else {
                        return Ok((None, json!({ "canceled": true })));
                    };
                    let selected = file.to_string_lossy().to_lowercase();
                    if [
                        "tasks.json",
                        "tasks.backup.json",
                        "tasks.pre-tauri.json",
                        "tasks.v1-original.json",
                        "tasks.v2-original.json",
                    ]
                    .iter()
                    .any(|name| directory.join(name).to_string_lossy().to_lowercase() == selected)
                    {
                        return Err("请选择数据目录以外的备份位置。".into());
                    }
                    fs::write(file, serde_json::to_string_pretty(&state).unwrap() + "\n")
                        .map_err(|_| "无法导出备份，请检查目标目录是否可写。")?;
                    Ok((None, json!({ "canceled": false })))
                } else {
                    let Some(file) = picker.set_title("导入侧记备份").pick_file() else {
                        return Ok((None, json!({ "canceled": true })));
                    };
                    if fs::metadata(&file).map_err(|_| "无法读取备份。")?.len() > 10 * 1024 * 1024
                    {
                        return Err("备份文件不能超过 10 MB。".into());
                    }
                    let raw: Value = serde_json::from_str(
                        &fs::read_to_string(file).map_err(|_| "无法读取备份。")?,
                    )
                    .map_err(|_| "无法读取备份，请选择有效的 JSON 文件。")?;
                    let imported = validate_state(&raw)?;
                    let confirm = rfd::MessageDialog::new().set_parent(&window).set_title("导入任务")
                        .set_description(format!("从备份中合并 {} 条任务？\n已有的同编号任务会跳过。现有任务和桌面设置都会保留。", imported.tasks.len()))
                        .set_buttons(rfd::MessageButtons::OkCancelCustom("导入".into(), "取消".into())).show();
                    if confirm != rfd::MessageDialogResult::Custom("导入".into())
                        && confirm != rfd::MessageDialogResult::Ok
                    {
                        return Ok((None, json!({ "canceled": true })));
                    }
                    Ok((Some(raw), json!({ "canceled": false })))
                }
            };
            let (imported, result) = match operation() {
                Ok((raw, result)) => (raw, Ok(result)),
                Err(error) => (None, Err(error)),
            };
            let _ = sender.send(Op::DialogFinished {
                imported,
                result,
                reply,
            });
        });
    }

    fn request(&mut self, command: &str, args: Value) -> Result<Value> {
        match command {
            "state:get" => Ok(
                json!({ "state": self.store.snapshot(), "window": self.windows.snapshot(), "warning": self.store.warning,
                "info": { "version": env!("CARGO_PKG_VERSION"), "platform": "win32", "runtime": "tauri", "dataPath": self.store.directory,
                    "canLaunchAtLogin": self.can_launch(), "canOpenDataFolder": true, "canNotify": self.notifications.is_some() || self.test_mode,
                    "shortcut": "Ctrl + Shift + Space", "shortcutRegistered": self.shortcut_registered } }),
            ),
            "task:add" | "task:update" | "task:delete" | "task:restore" | "task:undo"
            | "taxonomy:save" | "taxonomy:delete" => self.commit(command, args),
            "settings:set" => self.save_settings(args["patch"].clone()),
            "data:open-folder" => {
                platform::open_folder(&self.store.directory)?;
                Ok(Value::Null)
            }
            "window:toggle" => {
                self.toggle(false);
                Ok(Value::Null)
            }
            "window:set-expanded" => {
                if args["expanded"].as_bool().ok_or("窗口状态无效。")? {
                    self.expand(false, None);
                } else {
                    self.collapse();
                }
                Ok(Value::Null)
            }
            "window:collapse" => {
                self.collapse();
                Ok(Value::Null)
            }
            "window:start-drag" => {
                self.windows.request_drag(Instant::now())?;
                if let Err(error) = self.window.start_dragging() {
                    self.windows.end_drag(self.windows.bounds, Instant::now());
                    return Err(format!("无法拖动窗口：{error}"));
                }
                Ok(Value::Null)
            }
            "window:ready" => {
                self.windows
                    .ready(args["id"].as_u64().ok_or("窗口状态无效。")?);
                Ok(Value::Null)
            }
            "window:finished" => {
                self.windows
                    .finish(args["id"].as_u64().ok_or("窗口状态无效。")?);
                Ok(Value::Null)
            }
            "window:interaction" => {
                self.interaction = args["active"].as_bool().ok_or("交互状态无效。")?;
                self.protect();
                Ok(Value::Null)
            }
            "window:motion" => {
                self.windows.reduced_motion = args["reduced"].as_bool().ok_or("动画设置无效。")?;
                Ok(Value::Null)
            }
            "window:set-layout" => {
                self.windows
                    .set_view(args["layout"].as_str().ok_or("窗口布局无效。")?)?;
                Ok(Value::Null)
            }
            "window:reset-placement" => {
                self.windows.relocate(Placement::default());
                self.expand(false, None);
                Ok(Value::Null)
            }
            "app:ready" => {
                self.frontend_ready = true;
                self.published = Value::Null;
                self.pending_show = Some(self.windows.expanded);
                self.native_retry.reset();
                self.protect();
                for action in std::mem::take(&mut self.early_actions) {
                    self.action(action);
                }
                Ok(Value::Null)
            }
            "app:quit" => {
                self.quitting = true;
                Ok(Value::Null)
            }
            _ => Err("不支持这个操作。".into()),
        }
    }

    fn handle(&mut self, op: Op) {
        match op {
            Op::Request { command, args, reply } => {
                if command == "data:export" || command == "data:import" { self.start_dialog(command == "data:export", reply); }
                else {
                    let geometry_settings = command == "settings:set" && (args["patch"].get("windowPlacement").is_some() || args["patch"].get("dockSide").is_some());
                    let result = self.request(&command, args);
                    // Geometry requests resolve only after the owning thread
                    // applies them; data commits retain their durable result.
                    if geometry_settings || command.starts_with("window:") || command == "app:ready" || command == "state:get" {
                        self.pending_replies.push((reply, result));
                    } else { let _ = reply.blocking_send(result.map(|value| self.stamp(value))); }
                }
            }
            Op::NativeApplied { update, result, elapsed_ms } => {
                if self.native_inflight != Some(update.id) { return; }
                self.native_inflight = None;
                self.diagnostics.record("native-update", json!({"id": update.id, "elapsedMs": elapsed_ms, "success": result.is_ok(), "bounds": update.bounds, "region": update.region, "show": update.show}));
                match result {
                    Ok(focused) => {
                        if let Some(bounds) = update.bounds { self.applied_bounds = Some(platform::bounds(&self.window).unwrap_or(bounds)); }
                        if let Some(region) = update.region { self.applied_region = Some(region); }
                        if let Some(pin) = update.pin { self.applied_pin = Some(pin); }
                        if update.show.is_some() { self.windows.focused = focused; self.hidden_after_failure = false; }
                        self.native_retry.reset();
                        self.native_error = None;
                    }
                    Err(error) => {
                        self.applied_bounds = None; self.applied_region = None; self.applied_pin = None;
                        self.native_error = Some(error.clone());
                        self.hidden_after_failure = true;
                        self.native_retry.failed(Instant::now());
                        self.window_error(format!("窗口更新失败，已隐藏面板；请从托盘重新展开：{error}"));
                    }
                }
            }
            Op::Focus(focused) => {
                self.diagnostics.record("focus", json!({"focused": focused}));
                self.windows.focus(focused, Instant::now());
            },
            Op::DragBegin => { let _ = self.windows.start_drag(); }
            Op::Moved(bounds) => {
                // Windows can resize a window again while processing a DPI
                // change. Read current bounds instead of trusting an old event.
                self.applied_bounds = platform::bounds(&self.window).ok();
                self.windows.moved_native(self.applied_bounds.unwrap_or(bounds));
            }
            Op::DragEnd(bounds) => {
                self.windows.end_native_drag(platform::bounds(&self.window).unwrap_or(bounds), Instant::now());
                self.protect();
            }
            Op::DisplaysChanged => {
                if let Ok(monitors) = platform::monitors() {
                    if self.windows.dragging {
                        self.windows.monitors = monitors;
                        self.windows.monitor = self.windows.monitor.min(self.windows.monitors.len() - 1);
                        if let Ok(bounds) = platform::bounds(&self.window) { self.windows.moved_native(bounds); }
                    } else if self.windows.monitors != monitors {
                        self.windows.update_monitors(monitors); self.applied_bounds = None; self.applied_region = None;
                    }
                }
            }
            Op::Resume => { self.catch_up = true; self.next_reminder = Instant::now(); }
            Op::OpenReminders(ids) => self.expand(true, Some(json!({ "type": "open-reminders", "taskIds": ids }))),
            Op::NotificationFailed(ids) => self.action(json!({ "type": "notification-error", "message": "桌面通知未能显示，请检查 Windows 通知设置；到期任务仍可在侧栏查看。", "taskIds": ids })),
            Op::Menu(id) => match id.as_str() {
                "toggle" => self.toggle(true),
                "expand" => self.expand(true, None),
                "add" => self.expand(true, Some(json!("new-task"))),
                "settings" => self.expand(true, Some(json!("settings"))),
                "pin" => { if let Err(error) = self.save_settings(json!({ "alwaysOnTop": !self.store.snapshot().settings.always_on_top })) { self.window_error(error); } }
                "quit" => self.quitting = true,
                "collapse" => self.collapse(),
                _ => {}
            },
            Op::DialogFinished { imported, mut result, reply } => {
                if let Some(raw) = imported {
                    result = self.commit("data:import", json!({ "raw": raw })).map(|mut value| { value["canceled"] = json!(false); value });
                    self.catch_up = true;
                }
                self.native_dialog = false;
                self.protect();
                let _ = reply.blocking_send(result.map(|value| self.stamp(value)));
            }
            Op::Quit => self.quitting = true,
        }
    }

    fn run(mut self, receiver: Receiver<Op>) {
        if !self.test_mode
            || std::env::var("SIDETASK_TEST_NATIVE_NOTIFICATIONS").as_deref() == Ok("1")
        {
            match platform::Notifications::new(&self.store.directory) {
                Ok(notifications) => self.notifications = Some(notifications),
                Err(error) => self.notification_error = Some(format!("无法启用桌面通知：{error}")),
            }
        }
        self.sync();
        self.reminders();
        loop {
            let now = Instant::now();
            let mut wait = if self.windows.needs_tick() {
                Duration::from_millis(16)
            } else {
                self.next_reminder
                    .saturating_duration_since(now)
                    .min(Duration::from_secs(30))
            };
            for retry in [&self.native_retry, &self.placement_retry, &self.tray_retry] {
                if let Some(delay) = retry.remaining(now) {
                    wait = wait.min(delay);
                }
            }
            match receiver.recv_timeout(wait) {
                Ok(op) => {
                    let mut pending = op;
                    let mut received = 1;
                    let mut coalesced = 0;
                    for next in receiver.try_iter().take(63) {
                        received += 1;
                        if matches!(
                            (&pending, &next),
                            (Op::Moved(_), Op::Moved(_))
                                | (Op::DisplaysChanged, Op::DisplaysChanged)
                        ) {
                            coalesced += 1;
                        } else {
                            self.handle(pending);
                        }
                        pending = next;
                    }
                    self.handle(pending);
                    self.diagnostics.record(
                        "events",
                        json!({"received": received, "coalesced": coalesced}),
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            self.windows.tick(Instant::now());
            self.sync();
            if self.quitting {
                self.notifications.take();
                self.app.exit(0);
                break;
            }
            if Instant::now() >= self.next_reminder {
                self.reminders();
            }
        }
    }

    fn stamp(&self, mut value: Value) -> Value {
        if value.get("state").is_some() {
            value["state"] = json!(self.store.snapshot());
            value["revision"] = json!(self.revision);
        }
        if value.get("window").is_some() {
            value["window"] = self.windows.snapshot();
        }
        value
    }
}

pub fn run() {
    let _ = platform::init_identity();
    let (sender, receiver) = mpsc::channel();
    let backend = Backend(sender.clone());
    let result = tauri::Builder::default()
        .manage(backend)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            send(app, Op::Menu("expand".into()))
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        send(app, Op::Menu("toggle".into()));
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![request])
        .setup(move |app| {
            let directory = platform::data_directory()?;
            let test_mode = std::env::var("SIDETASK_TEST_MODE").as_deref() == Ok("1");
            if !test_mode && platform::legacy_instance_running() {
                return Err("请先保存草稿，并从托盘退出正在运行的旧版侧记，再启动轻量版。".into());
            }
            let mut store = TaskStore::open(&directory)?;
            if !cfg!(debug_assertions) && !test_mode {
                let actual = platform::startup_enabled();
                if actual {
                    platform::set_startup(true)?;
                }
                if actual != store.snapshot().settings.launch_at_login {
                    store.transact(
                        "settings:set",
                        json!({ "patch": { "launchAtLogin": actual } }),
                        Utc::now(),
                    )?;
                }
            }
            let settings = &store.snapshot().settings;
            let expanded = !std::env::args().any(|arg| arg == "--hidden");
            let mut windows = WindowController::new(
                settings.window_placement.clone(),
                settings.calendar_view.clone(),
                platform::monitors()?,
                expanded,
            );
            windows.auto_collapse = settings.auto_collapse;
            windows.protected = true;
            let size = windows
                .native_bounds()
                .divided(windows.current_monitor().scale);
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("src/index.html".into()))
                    .title("侧记 SideTask")
                    .inner_size(size.width, size.height)
                    .min_inner_size(1.0, 1.0)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .resizable(false)
                    .maximizable(false)
                    .minimizable(false)
                    .skip_taskbar(true)
                    .visible(false)
                    .focused(false)
                    .disable_drag_drop_handler()
                    .data_directory(directory.join("webview"))
                    .on_navigation(allowed_url);
            if test_mode {
                if let Ok(arguments) = std::env::var("SIDETASK_TEST_BROWSER_ARGS") {
                    builder = builder.additional_browser_args(&arguments);
                }
            }
            let window = builder.build()?;
            platform::install_hook(&window, sender.clone())?;
            let events = sender.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(focused) => {
                    let _ = events.send(Op::Focus(*focused));
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = events.send(Op::Menu("collapse".into()));
                }
                WindowEvent::Destroyed => {
                    let _ = events.send(Op::Quit);
                }
                _ => {}
            });
            let shortcut_registered = app.global_shortcut().register("Ctrl+Shift+Space").is_ok();
            TrayIconBuilder::with_id("sidetask")
                .icon(Image::from_bytes(include_bytes!("../../assets/tray.png"))?)
                .tooltip("侧记")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| send(app, Op::Menu(event.id.as_ref().to_owned())))
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        send(tray.app_handle(), Op::Menu("toggle".into()));
                    }
                })
                .build(app)?;
            let pending_count = store
                .snapshot()
                .tasks
                .iter()
                .filter(|task| task.completed_at.is_none())
                .count();
            let runtime = Runtime {
                app: app.handle().clone(),
                window,
                sender,
                store,
                windows,
                interaction: false,
                native_dialog: false,
                frontend_ready: false,
                shortcut_registered,
                pending_action: None,
                early_actions: vec![],
                published: Value::Null,
                applied_bounds: None,
                applied_region: None,
                applied_pin: None,
                native_inflight: None,
                native_sequence: 0,
                pending_show: None,
                pending_replies: vec![],
                native_error: None,
                hidden_after_failure: false,
                pending_count,
                native_retry: RetryGate::default(),
                placement_retry: RetryGate::default(),
                tray_retry: RetryGate::default(),
                last_window_error: None,
                diagnostics: Diagnostics::new(&directory),
                tray_state: None,
                notifications: None,
                notification_error: None,
                next_reminder: Instant::now(),
                last_reminder: None,
                catch_up: true,
                test_mode,
                quitting: false,
                revision: 0,
            };
            std::thread::Builder::new()
                .name("sidetask-backend".into())
                .spawn(move || runtime.run(receiver))?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        rfd::MessageDialog::new()
            .set_title("侧记无法启动")
            .set_description(format!(
                "{error}\n\n如果电脑尚未安装 WebView2，请运行侧记安装包完成运行组件安装。"
            ))
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
}
