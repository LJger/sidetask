#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod platform;

fn main() {
    #[cfg(windows)]
    desktop::run();
    #[cfg(not(windows))]
    eprintln!("SideTask 桌面版支持 Windows 10/11。此平台可运行 npm run preview 和 cargo test。");
}
