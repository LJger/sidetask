use crate::desktop::Op;
use sidetask_core::{
    domain::{reminder_key, Task},
    geometry::{Monitor, Point, Rect},
    Result,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::mpsc::Sender,
};
use tauri::WebviewWindow;
use windows::{
    core::{w, IInspectable, BOOL, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::{
        Foundation::{
            GetLastError, SetLastError, ERROR_SUCCESS, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
        },
        Graphics::Gdi::{
            CreateRectRgn, DeleteObject, EnumDisplayMonitors, GetMonitorInfoW, SetWindowRgn, HDC,
            HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW,
        },
        System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
        UI::{
            HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            Shell::{
                DefSubclassProc, RemoveWindowSubclass, SetCurrentProcessExplicitAppUserModelID,
                SetWindowSubclass,
            },
            WindowsAndMessaging::*,
        },
    },
    UI::Notifications::{
        ToastFailedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

pub const APP_ID: &str = "com.sidetask.desktop";

#[derive(Clone, Debug)]
pub struct NativeUpdate {
    pub id: u64,
    pub bounds: Option<Rect>,
    pub region: Option<Option<Rect>>,
    pub pin: Option<bool>,
    // None: keep visibility; false: show inactive; true: request foreground once.
    pub show: Option<bool>,
}

pub fn queue_update(
    window: &WebviewWindow,
    update: NativeUpdate,
    sender: Sender<Op>,
) -> Result<()> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let started = std::time::Instant::now();
            let result = apply_update(&target, &update);
            let _ = sender.send(Op::NativeApplied {
                update,
                result,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        })
        .map_err(|error| error.to_string())
}

fn apply_update(window: &WebviewWindow, update: &NativeUpdate) -> Result<bool> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let operation = || -> Result<bool> {
        // Restrict input before relocating a collapsed surface. Clear clipping
        // only after expanded geometry has been applied, on this same UI thread.
        if let Some(Some(region)) = update.region {
            set_region(window, Some(region))?;
        }
        if let Some(bounds) = update.bounds {
            set_bounds(window, bounds)?;
        }
        if update.region == Some(None) {
            set_region(window, None)?;
        }
        if let Some(pin) = update.pin {
            unsafe {
                SetWindowPos(
                    hwnd,
                    Some(if pin { HWND_TOPMOST } else { HWND_NOTOPMOST }),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
                .map_err(|error| error.to_string())?;
            }
        }
        if let Some(activate) = update.show {
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                // Tao's set_focus fallback injects Alt. Never use that fallback:
                // Windows may legitimately reject foreground activation.
                if activate && GetForegroundWindow() != hwnd {
                    let _ = SetForegroundWindow(hwnd);
                }
            }
        }
        Ok(unsafe { GetForegroundWindow() == hwnd })
    };
    let result = operation();
    if result.is_err() {
        // A failed region update must not leave an invisible topmost rectangle
        // intercepting another application's input. Tray actions can retry.
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
    result
}

pub fn legacy_instance_running() -> bool {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe extern "system" fn inspect(hwnd: HWND, data: LPARAM) -> BOOL {
        let mut class = [0u16; 128];
        let length = GetClassNameW(hwnd, &mut class) as usize;
        if !String::from_utf16_lossy(&class[..length]).starts_with("Chrome_WidgetWin") {
            return true.into();
        }
        let mut title = [0u16; 256];
        let length = GetWindowTextW(hwnd, &mut title) as usize;
        if !String::from_utf16_lossy(&title[..length]).contains("侧记") {
            return true.into();
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut image = [0u16; 2048];
            let mut size = image.len() as u32;
            let read = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(image.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(process);
            if read.is_ok() {
                let path = String::from_utf16_lossy(&image[..size as usize]).to_lowercase();
                if path.ends_with("\\sidetask.exe") || path.ends_with("\\electron.exe") {
                    *(data.0 as *mut bool) = true;
                    return false.into();
                }
            }
        }
        true.into()
    }
    let mut found = false;
    unsafe {
        let _ = EnumWindows(Some(inspect), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

fn rect(value: RECT) -> Rect {
    Rect {
        x: value.left as f64,
        y: value.top as f64,
        width: (value.right - value.left) as f64,
        height: (value.bottom - value.top) as f64,
    }
}

pub fn monitors() -> Result<Vec<Monitor>> {
    unsafe extern "system" fn collect(
        handle: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<Monitor>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(handle, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            let mut x = 96;
            let mut y = 96;
            let _ = GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut x, &mut y);
            let end = info
                .szDevice
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(info.szDevice.len());
            monitors.push(Monitor {
                id: String::from_utf16_lossy(&info.szDevice[..end]),
                bounds: rect(info.monitorInfo.rcMonitor),
                work_area: rect(info.monitorInfo.rcWork),
                scale: f64::from(x) / 96.0,
                primary: info.monitorInfo.dwFlags & 1 != 0,
            });
        }
        true.into()
    }
    let mut result: Vec<Monitor> = vec![];
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut result as *mut _ as isize),
        )
        .ok()
        .map_err(|e| e.to_string())?;
    }
    if result.is_empty() {
        return Err("无法读取显示器工作区。".into());
    }
    // Forced WebView2 scale is used only by automated tests. Normal launches
    // always use actual monitor DPI; Windows display settings are never changed.
    if std::env::var("SIDETASK_TEST_MODE").as_deref() == Ok("1") {
        if let Ok(scale) = std::env::var("SIDETASK_TEST_SCALE")
            .unwrap_or_default()
            .parse::<f64>()
        {
            if [1.0, 1.25, 1.5, 2.0].contains(&scale) {
                for monitor in &mut result {
                    monitor.scale = scale;
                }
            }
        }
    }
    Ok(result)
}

pub fn cursor() -> Point {
    let mut point = POINT::default();
    let _ = unsafe { GetCursorPos(&mut point) };
    Point {
        x: point.x as f64,
        y: point.y as f64,
    }
}

pub fn bounds(window: &WebviewWindow) -> Result<Rect> {
    let mut value = RECT::default();
    unsafe {
        GetWindowRect(window.hwnd().map_err(|e| e.to_string())?, &mut value)
            .map_err(|e| e.to_string())?;
    }
    Ok(rect(value))
}

pub fn set_bounds(window: &WebviewWindow, bounds: Rect) -> Result<()> {
    unsafe {
        SetWindowPos(
            window.hwnd().map_err(|e| e.to_string())?,
            None,
            bounds.x.round() as i32,
            bounds.y.round() as i32,
            bounds.width.round() as i32,
            bounds.height.round() as i32,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_region(window: &WebviewWindow, bounds: Option<Rect>) -> Result<()> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let region = if let Some(bounds) = bounds {
            let region = CreateRectRgn(
                bounds.x.round() as i32,
                bounds.y.round() as i32,
                (bounds.x + bounds.width).round() as i32,
                (bounds.y + bounds.height).round() as i32,
            );
            if region.0.is_null() {
                return Err("无法创建窗口可见区域。".into());
            }
            Some(region)
        } else {
            None
        };
        // A window region clips both drawing and input. The hidden panel cannot
        // intercept desktop clicks, and WebView2 never loses its handle frame
        // to a viewport resize when collapsing or expanding.
        if SetWindowRgn(hwnd, region, true) == 0 {
            if let Some(region) = region {
                let _ = DeleteObject(HGDIOBJ(region.0));
            }
            return Err("无法更新窗口可见区域。".into());
        }
        // Windows owns the region after a successful SetWindowRgn call.
    }
    Ok(())
}

fn frameless_style(index: WINDOW_LONG_PTR_INDEX, style: u32) -> u32 {
    let frame = if index == GWL_STYLE {
        WS_CAPTION.0 | WS_THICKFRAME.0
    } else if index == GWL_EXSTYLE {
        WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0 | WS_EX_DLGMODALFRAME.0 | WS_EX_STATICEDGE.0
    } else {
        0
    };
    // Keep WS_SYSMENU for Alt+F4, along with visibility, transparency and Z-order.
    style & !frame
}

fn clear_native_frame(hwnd: HWND) -> Result<()> {
    unsafe {
        for index in [GWL_STYLE, GWL_EXSTYLE] {
            let current = GetWindowLongPtrW(hwnd, index) as u32;
            let next = frameless_style(index, current);
            if current == next {
                continue;
            }
            // A zero return can be a valid previous style, especially GWL_EXSTYLE.
            SetLastError(ERROR_SUCCESS);
            if SetWindowLongPtrW(hwnd, index, next as isize) == 0 && GetLastError() != ERROR_SUCCESS
            {
                return Err(format!(
                    "无法禁用系统窗口边框：{}",
                    windows::core::Error::from_win32()
                ));
            }
        }
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|error| format!("无法更新无边框窗口：{error}"))?;
    }
    Ok(())
}

pub fn install_hook(window: &WebviewWindow, sender: Sender<Op>) -> Result<()> {
    unsafe extern "system" fn callback(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let sender = &*(data as *const Sender<Op>);
        match message {
            WM_STYLECHANGING if lparam.0 != 0 => {
                // Tao rewrites the caption/edge styles when changing visibility
                // or topmost state. Filter the proposed styles before Windows
                // applies them, so no intermediate decorated frame can be drawn.
                let styles = &mut *(lparam.0 as *mut STYLESTRUCT);
                styles.styleNew =
                    frameless_style(WINDOW_LONG_PTR_INDEX(wparam.0 as i32), styles.styleNew);
            }
            WM_NCCALCSIZE | WM_NCPAINT => {
                // The fixed-size sidebar uses the entire HWND as its client area,
                // including the wParam == FALSE form of WM_NCCALCSIZE.
                return LRESULT(0);
            }
            WM_NCACTIVATE => {
                // Tao must still update its active/focused state for auto-collapse.
                // -1 tells DefWindowProc to skip painting the non-client area.
                return DefSubclassProc(hwnd, message, wparam, LPARAM(-1));
            }
            WM_ENTERSIZEMOVE => {
                let _ = sender.send(Op::DragBegin);
            }
            WM_MOVE | WM_SIZE | WM_EXITSIZEMOVE => {
                let mut value = RECT::default();
                if GetWindowRect(hwnd, &mut value).is_ok() {
                    let _ = sender.send(if message == WM_EXITSIZEMOVE {
                        Op::DragEnd(rect(value))
                    } else {
                        Op::Moved(rect(value))
                    });
                }
            }
            WM_DISPLAYCHANGE | WM_DPICHANGED => {
                let _ = sender.send(Op::DisplaysChanged);
            }
            WM_SETTINGCHANGE if wparam.0 == SPI_SETWORKAREA.0 as usize => {
                let _ = sender.send(Op::DisplaysChanged);
            }
            WM_POWERBROADCAST
                if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC
                    || wparam.0 as u32 == PBT_APMRESUMESUSPEND =>
            {
                let _ = sender.send(Op::Resume);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(callback), id);
                drop(Box::from_raw(data as *mut Sender<Op>));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
    let handle = window.hwnd().map_err(|e| e.to_string())?;
    let data = Box::into_raw(Box::new(sender));
    if !unsafe { SetWindowSubclass(handle, Some(callback), 0x53494445, data as usize).as_bool() } {
        unsafe {
            drop(Box::from_raw(data));
        }
        return Err("无法启用窗口消息处理。".into());
    }
    // Install the style guard first, then remove the styles already assigned by
    // Tao. This runs on the window thread before the initially hidden HWND is shown.
    clear_native_frame(handle)
}

pub fn data_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("SIDETASK_USER_DATA") {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("APPDATA")
        .map(|path| PathBuf::from(path).join("SideTask"))
        .ok_or_else(|| "无法定位用户数据目录。".into())
}

pub fn open_folder(directory: &Path) -> Result<()> {
    std::process::Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开数据目录。".into())
}

pub fn startup_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .and_then(|key| key.get_value::<String, _>("SideTask"))
        .is_ok_and(|value| !value.is_empty())
}

pub fn set_startup(enabled: bool) -> Result<()> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|_| "无法更改开机启动设置，请检查 Windows 启动应用权限。")?;
    if enabled {
        let path = std::env::current_exe().map_err(|_| "无法定位应用程序。")?;
        key.set_value("SideTask", &format!("\"{}\" --hidden", path.display()))
            .map_err(|_| "无法更改开机启动设置。")?;
    } else if let Err(error) = key.delete_value("SideTask") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err("无法更改开机启动设置。".into());
        }
    }
    Ok(())
}

pub fn init_identity() -> Result<()> {
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(w!("com.sidetask.desktop"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct Notice {
    toast: ToastNotification,
    tasks: Vec<(String, String)>,
}
pub struct Notifications {
    notifier: ToastNotifier,
    notices: HashMap<String, Notice>,
}

impl Notifications {
    pub fn new(directory: &Path) -> Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).map_err(|e| e.to_string())?;
        }
        // An unpackaged application can register its own per-user notification
        // identity; portable builds therefore do not masquerade as PowerShell.
        let icon = directory.join("notification-icon.png");
        std::fs::write(&icon, include_bytes!("../../assets/icon.png"))
            .map_err(|e| e.to_string())?;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))
            .map_err(|e| e.to_string())?;
        key.set_value("DisplayName", &"侧记 SideTask")
            .map_err(|e| e.to_string())?;
        key.set_value("IconUri", &icon.to_string_lossy().as_ref())
            .map_err(|e| e.to_string())?;
        key.set_value("ShowInSettings", &1u32)
            .map_err(|e| e.to_string())?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            notifier,
            notices: HashMap::new(),
        })
    }

    pub fn show(&mut self, tasks: &[Task], missed: bool, sender: Sender<Op>) -> Result<()> {
        if tasks.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
        let title = if missed {
            "侧记 · 错过的提醒"
        } else {
            "侧记 · 任务到期"
        };
        let body = if tasks.len() == 1 {
            tasks[0].title.clone()
        } else {
            format!(
                "{} 条任务：{}",
                tasks.len(),
                tasks
                    .iter()
                    .take(3)
                    .map(|task| task.title.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            )
        };
        let xml = XmlDocument::new().map_err(|e| e.to_string())?;
        let escape = |text: &str| {
            text.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&apos;")
        };
        xml.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", escape(title), escape(&body)))).map_err(|e| e.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml).map_err(|e| e.to_string())?;
        // Windows toast tags are limited to 16 characters.
        let tag = uuid::Uuid::new_v4().simple().to_string()[..16].to_owned();
        toast
            .SetTag(&HSTRING::from(&tag))
            .map_err(|e| e.to_string())?;
        toast
            .SetGroup(&HSTRING::from("sidetask"))
            .map_err(|e| e.to_string())?;
        let clicked = sender.clone();
        let failed_ids = ids.clone();
        toast
            .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                move |_, _| {
                    let _ = clicked.send(Op::OpenReminders(ids.clone()));
                    Ok(())
                },
            ))
            .map_err(|e| e.to_string())?;
        toast
            .Failed(
                &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
                    let _ = sender.send(Op::NotificationFailed(failed_ids.clone()));
                    Ok(())
                }),
            )
            .map_err(|e| e.to_string())?;
        self.notifier
            .Show(&toast)
            .map_err(|_| "桌面通知未能显示，请检查 Windows 通知设置；到期任务仍可在侧栏查看。")?;
        self.notices.insert(
            tag,
            Notice {
                toast,
                tasks: tasks
                    .iter()
                    .filter_map(|t| reminder_key(t).map(|key| (t.id.clone(), key)))
                    .collect(),
            },
        );
        Ok(())
    }

    pub fn reconcile(&mut self, tasks: &[Task]) {
        self.notices.retain(|_, notice| {
            let current = notice.tasks.iter().all(|(id, key)| {
                tasks.iter().any(|task| {
                    &task.id == id
                        && task.completed_at.is_none()
                        && reminder_key(task).as_ref() == Some(key)
                })
            });
            if !current {
                let _ = self.notifier.Hide(&notice.toast);
            }
            current
        });
    }
}

impl Drop for Notifications {
    fn drop(&mut self) {
        for notice in self.notices.values() {
            let _ = self.notifier.Hide(&notice.toast);
        }
    }
}
