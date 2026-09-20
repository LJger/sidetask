# 侧记 SideTask 1.3.5

## 更新内容

- 修正展开、收起时系统标题栏与边框短暂闪现的问题。首次显示前清除系统装饰样式，并过滤运行时对窗口样式的重写，同时保留 Alt+F4 收起。
- 桌面自动化改为等待 WebView2 出现应用页面后再建立会话，避免测试驱动中止首次页面加载；新增原生边框回归长测、焦点反转与 Alt+F4 探针。

## 下载与升级

- `SideTask-Setup-1.3.5-x64.exe`：Windows x64 安装版，推荐使用。
- `SideTask-Portable-1.3.5-x64.exe`：Windows x64 便携版。
- 同名 `.sha256` 文件用于核验下载文件。

升级前请保存草稿并从托盘退出旧版。继续使用 v3 数据格式和原有用户数据目录。安装包会在缺少 WebView2 时联网补装运行时。

## 验证范围

已通过 71 项 JavaScript 测试和 20 项 Rust 核心测试。Windows 11 上的原生边框回归长测通过：置顶开启、关闭各 40 轮展开收起，2,674 次窗口样式采样中系统边框样式出现 0 次；焦点反转、Alt+F4、保存、草稿保护与重启持久化检查通过。详细记录见 [1.3.5 验证记录](https://github.com/LJger/sidetask/blob/v1.3.5/docs/verification-1.3.5.md) 和 [窗口边框验证记录](https://github.com/LJger/sidetask/blob/v1.3.5/docs/verification-window-frame.md)。

真实鼠标拖动、多显示器与 DPI、安装升级流程以及 Edge 收藏夹、Nexus 等程序的交互仍待复验。
