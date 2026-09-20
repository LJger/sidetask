# 展开、收起时系统边框闪现：修复与验证记录

2026-09-20 更新，基于 1.3.4。应用版本和 v3 数据格式保持兼容。首轮修复于 2026-09-15 基于 1.3.3 完成，1.3.4 正式发布时未包含该修复，本轮将其合并到 1.3.4 并重新验证。

## 问题与修改

运行中的原版主窗口样式为 `0x14C80000`，仍包含系统标题栏和边框；扩展样式也带有 `WS_EX_WINDOWEDGE`。当前依赖 Tao 0.35.3 通过非客户区消息隐藏装饰，置顶、显示状态变化时会重新写入这些样式并触发边框刷新。应用的 `SetWindowRgn` 裁剪切换也会触发原生重绘，形成与偶发系统框吻合的触发路径。

修复集中在 `src-tauri/src/platform.rs`：

- 首次显示前清除标题栏、缩放边框和扩展边框样式，并通过 `WM_STYLECHANGING` 过滤后续写入。
- 完整处理两种 `WM_NCCALCSIZE` 参数形式，阻止默认 `WM_NCPAINT` 绘制。
- 将 `WM_NCACTIVATE` 继续传递给 Tao，同时以 `lParam = -1` 禁止默认非客户区重绘，保留焦点状态更新。
- 保留 `WS_SYSMENU`，使 Alt+F4 继续走原有收起流程。沿用原来的动画时长与窗口裁剪机制。

1.3.4 已将窗口更新集中到 UI 线程的 `apply_update`，本轮修复只叠加样式过滤与非客户区消息处理，不改动 1.3.4 的更新合并与重试逻辑。

测试脚本同步调整：`scripts/desktop-smoke.mjs` 改为等待 WebView2 调试端口出现应用页面目标后再建立会话。此前只检测调试端口就绪，EdgeDriver 在页面仍为 `about:blank` 时附着会中止应用页面的首次导航，导致前端永远不就绪。

## 已完成验证

环境：Windows 11（系统版本 10.0.26200）、WebView2 153.0.4234.48、EdgeDriver 153.0.4234.48，主显示器 100% 缩放，双显示器。原生测试使用临时数据目录；测试构建使用独立应用标识 `com.sidetask.frame-regression`，与托盘中运行的正式版 1.3.4 并存。交付文件使用正式标识 `com.sidetask.desktop`。

- 在 WSL 使用 cargo-xwin 与本地 LLVM 14 完成 Windows x64 Release 交叉构建。
- 20 项 Rust 核心测试、71 项 JavaScript 测试通过；`cargo fmt --check` 通过。
- 原生长测通过：置顶开启、关闭各 40 轮，每组包含 20 轮正常开关、20 轮动画中连续反转。
- 2,674 次原生样式采样中，系统边框样式出现次数为 0；实际窗口样式稳定为 `14080000`，扩展样式随置顶状态在 `00040018` / `00040010` 间切换。
- 4 次展开中失焦、恢复焦点的原生反转检查通过；消息记录确认经过 `expanding → collapsing → expanding → expanded`。
- 2 次真实 Alt+F4 输入检查通过，收起后可再次点击展开。
- 原生保存、草稿保护、并发写入、失败保存恢复、隐藏启动及重启持久化检查通过。

本轮长测证据位于 `test-results/native-frames-1789911019264/report.json`。2026-09-15 基于 1.3.3 的 200 轮长测与约 191 秒录屏证据位于 `test-results/native-frames-1789394720028/`。

## 待验证

四边停靠及不同 DPI 下的真实拖动、混合 DPI 跨屏、Windows 10、安装升级流程仍待实测。本轮未录制桌面画面。

## 复验方式

按 README 准备匹配 WebView2 版本的 EdgeDriver。使用正式标识测试前，从托盘退出旧实例；测试使用独立临时数据目录。

```powershell
$env:SIDETASK_TEST_EXECUTABLE = (Resolve-Path 'release\SideTask-Portable-1.3.4-frame-fix-x64.exe').Path
$env:SIDETASK_TEST_FRAME_STRESS = '1'
$env:SIDETASK_TEST_NATIVE_DRAG = '0'
$env:SIDETASK_TEST_QUICK = '1'
npm run test:desktop
```

设置 `SIDETASK_TEST_FRAME_FFMPEG` 为支持 MJPEG 输入和 libvpx 编码的 FFmpeg 路径可同步录制桌面画面。`SIDETASK_TEST_FRAME_CYCLES` 默认每种置顶状态 200 轮，缩短专项排查时可设为 2。原生探针同时检查真实窗口样式和客户区边界，并在长测中连续采样。

## 本地修复版

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `release/SideTask-Portable-1.3.4-frame-fix-x64.exe` | 3443712 | `073775687e058ba4396f4c2258f3128c642945c994d20d7c0ae18570fd441a5b` |
| `release/SideTask-Setup-1.3.4-frame-fix-x64.exe` | 1476119 | `dd35dc18be6df4974cd59dbf372cc36c86519f77471b7d520ba0546dab7f17a7` |

安装包在 WSL 使用本地 NSIS 3.08 与现有安装器模板交叉打包，未签名；两个文件的版本资源均为 1.3.4。安装包沿用 1.3.4 版本号，如需正式发布应先提升版本号并通过 Windows 构建工作流重新生成。

从托盘退出旧版，再运行安装包或便携版。对应校验文件与可执行文件放在同一目录。
