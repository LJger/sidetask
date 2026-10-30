# SideTask 1.4.1 发布验证

## 发布内容

本次包含界面与设置页调整、标签和视图切换动效，以及 Windows 侧栏工具窗口样式修正。应用、安装包和浏览器预览版本统一为 1.4.1，继续使用 v3 数据格式。完整更新内容见 [发布说明](release-1.4.1.md)。

## 已完成检查

- 44 个 JavaScript 文件语法检查通过。
- 72 项 JavaScript 测试通过。
- 42 项浏览器界面测试用例在 Windows Chromium 环境执行通过。
- Windows 构建工作流中的 72 项 JavaScript 测试、21 项 Rust 原生测试和 42 项浏览器界面测试通过。
- Rust 格式检查及 Windows Clippy 检查通过，Clippy 将警告视为错误。
- 构建来源为 [Windows 构建 40994229649](https://github.com/LJger/sidetask/actions/runs/40994229649)，源码提交为 `49daa987c07b7dc63a791a57ea702cbd5ed15396`，对应标签 `v1.4.1`。
- Windows x64 Release 原生构建和 NSIS 安装包生成通过。
- 安装版与便携版的文件版本、产品版本均为 1.4.1，两份 SHA-256 校验文件与下载产物一致。

## 桌面复验与验证范围

初次构建的桌面测试在连接阶段超时。EdgeDriver 日志显示，应用页面 URL 已更新，但标题仍为 `about:blank`，测试连接时将未完成的导航切换到了空白页。提交 `2a7bc3f` 修正了测试脚本，连接前同时等待应用 URL 和非空页面标题；应用源码与发布二进制未改变。

使用原始产物执行的 [Windows 桌面复验 41009892826](https://github.com/LJger/sidetask/actions/runs/41009892826) 已通过原生启动与版本检查、保存、24 组收起展开、焦点与草稿保护、并发写入、失败保存恢复和重复任务撤销检查。窗口保持无系统边框，系统关闭菜单标志及工具窗口标志均正常。

复验仍在文件对话框自动化步骤失败：测试脚本无法定位系统导出对话框中的文件名控件，报错为 `Could not locate the file-name control`，与 1.4.0 及此前版本记录的问题相同。因此桌面工作流整体结果为失败，不能视为全量桌面测试通过；该步骤之前的检查已通过，后续隐藏启动与重启检查未执行。本次沿用既有发布方式，并保留此项自动化验证限制。

Edge 收藏夹等第三方程序的交互、多显示器与 DPI、Windows 10 和安装升级流程仍需实机复验。

## 发布文件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SideTask-Portable-1.4.1-x64.exe` | 3438592 | `10ca623eb4bad0b3ad12f6cf39d72aa8b25b1148e0feabad6a786e44fb6e5375` |
| `SideTask-Setup-1.4.1-x64.exe` | 1376535 | `44f2a7e1648c773508baf40025863fcc613bd8888ef3dd49d509b880831935c7` |

安装版、便携版与各自的 `.sha256` 文件见 [GitHub 1.4.1 发布页](https://github.com/LJger/sidetask/releases/tag/v1.4.1)。本地文件位于 `release` 目录。
