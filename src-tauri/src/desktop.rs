use crate::platform;
use chrono::{Local, Utc};
use serde_json::{json, Value};
use sidetask_core::{domain::*, geometry::*, store::TaskStore, window::WindowController, Result};
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
        self.action(json!({ "type": "window-error", "message": error }));
    }

    fn emit_state(&mut self) {
        self.revision += 1;
        if self.frontend_ready {
            let _ = self.window.emit(
                "state:changed",
                json!({"state": self.store.snapshot(), "revision": self.revision}),
            );
        }
        if let Some(notifications) = &mut self.notifications {
            notifications.reconcile(&self.store.snapshot().tasks);
        }
        self.next_reminder = Instant::now();
    }

    fn commit(&mut self, command: &str, args: Value) -> Result<Value> {
        let response = self.store.transact(command, args, Utc::now())?;
        self.emit_state();
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
        self.windows.focused = true;
        self.windows.expand(Instant::now());
        if self.frontend_ready {
            let _ = self.window.show();
            let _ = self.window.set_focus();
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
        if !self.windows.expanded || self.windows.snapshot()["docking"] == true {
            self.expand(cursor, None);
        } else {
            self.collapse();
        }
    }

    fn save_settings(&mut self, patch: Value) -> Result<Value> {
        let previous = self.store.snapshot().settings.clone();
        let settings = validate_settings(&patch, &previous)?;
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
        let pending = self
            .store
            .snapshot()
            .tasks
            .iter()
            .filter(|task| task.completed_at.is_none())
            .count();
        let pin = self.store.snapshot().settings.always_on_top;
        let state = (self.windows.expanded, pin, pending);
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
        let bounds = self.windows.native_bounds();
        if !self.windows.dragging && self.applied_bounds != Some(bounds) {
            if let Err(error) = platform::set_bounds(&self.window, bounds) {
                self.window_error(format!("无法调整窗口位置：{error}"));
            } else {
                self.applied_bounds = Some(bounds);
            }
        }
        let region = self.windows.native_region();
        if self.applied_region != Some(region) {
            if let Err(error) = platform::set_region(&self.window, region) {
                self.window_error(error);
            } else {
                self.applied_region = Some(region);
            }
        }
        let pin = !self.windows.expanded || self.store.snapshot().settings.always_on_top;
        if self.applied_pin != Some(pin) {
            if let Err(error) = self.window.set_always_on_top(pin) {
                self.window_error(format!("无法调整窗口置顶：{error}"));
            }
            self.applied_pin = Some(pin);
        }
        let state = self.windows.snapshot();
        if state != self.published {
            if self.frontend_ready {
                let _ = self.window.emit("window:changed", &state);
            }
            self.published = state;
        }
        if self.windows.settled() {
            if self.windows.placement != self.store.snapshot().settings.window_placement {
                let args = json!({ "patch": { "windowPlacement": self.windows.placement } });
                if let Err(error) = self.commit("settings:set", args) {
                    self.window_error(format!("窗口位置未保存：{error}"));
                }
            }
            if self.windows.expanded && self.frontend_ready {
                if let Some(action) = self.pending_action.take() {
                    self.action(action);
                }
            }
        }
        if let Err(error) = self.refresh_tray() {
            self.window_error(format!("无法更新托盘菜单：{error}"));
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
                    self.emit_state();
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
                if self.windows.expanded {
                    self.windows.focused = true;
                    let _ = self.window.show();
                    let _ = self.window.set_focus();
                } else {
                    platform::show_inactive(&self.window);
                }
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
                    let result = self.request(&command, args);
                    // Publish geometry before resolving the IPC promise. A
                    // caller can immediately click after changing displays.
                    self.sync();
                    let _ = reply.blocking_send(result.map(|value| self.stamp(value)));
                }
            }
            Op::Focus(focused) => self.windows.focus(focused, Instant::now()),
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
                    } else { self.windows.update_monitors(monitors); self.applied_bounds = None; }
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
            let wait = if self.windows.needs_tick() {
                Duration::from_millis(16)
            } else {
                self.next_reminder
                    .saturating_duration_since(now)
                    .min(Duration::from_secs(30))
            };
            match receiver.recv_timeout(wait) {
                Ok(op) => self.handle(op),
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
            let size = windows.native_bounds().divided(windows.current_monitor().scale);
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
