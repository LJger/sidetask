# SideTask 1.3.4 发布验证

## 发布内容

本次包含提交 `c4aabeb` 的日历操作、完成状态显示、面板透明度和桌面窗口处理改进。应用及浏览器预览版本统一为 1.3.4，继续使用 v3 数据格式。完整更新内容见 [发布说明](release-1.3.4.md)。

## 已完成检查

- 43 个 JavaScript 文件语法检查通过。
- 71 项 JavaScript 测试和 21 项 Rust 测试通过。
- 39 项浏览器界面测试通过；在 Linux Microsoft Edge 和 Windows Chromium 环境运行。
- Rust 格式检查通过，Linux 和 Windows x64 目标的 Clippy 检查通过。
- Windows x64 Release 原生构建和 NSIS 安装包生成通过，使用生产静态资源、LTO、体积优化及静态 C 运行库。
- 发布文件来自 [Windows 构建 35433101811](https://github.com/LJger/sidetask/actions/runs/35433101811)，构建提交为 `caf695d`。后续提交仅调整测试脚本、工作流和发布文档，没有修改应用源码或生产配置。
- 安装版和便携版的文件及产品版本资源均为 1.3.4.0，SHA-256 校验文件与产物一致。
- 修正测试驱动连接方式后，原生启动、保存、24 组收起展开、焦点与草稿保护、并发写入、失败保存恢复和重复任务撤销检查通过。

## 验证范围

Windows 桌面自动化未全部通过：早期运行因测试驱动寻找 DevToolsActivePort 文件失败而未建立会话；改为本机端口连接后，上述原生操作检查通过，导出对话框测试随后因预期路径没有生成文件而中止。文件对话框测试脚本已调整，但完整复验尚未完成。

按用户要求停止进一步检查并直接发布，由用户自行复验安装升级、导入导出、重启、实际鼠标拖动、多显示器与 DPI，以及 Edge 收藏夹和 Nexus 等程序的交互。

升级前请保存草稿并从托盘退出旧版。

## 发布文件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `SideTask-Portable-1.3.4-x64.exe` | 3450880 | `b8a9fa298f3788fe55bf25a0b4a22092662b567fc0089892f243090dbe6209cb` |
| `SideTask-Setup-1.3.4-x64.exe` | 1367326 | `1aef9f6a9df564231f72ede5bc574b680ed8a297e5c29fbc2155adbe09f79e6a` |

安装版、便携版与各自的 `.sha256` 文件见 [GitHub 1.3.4 发布页](https://github.com/LJger/sidetask/releases/tag/v1.3.4)。本地文件位于 `release` 目录。
