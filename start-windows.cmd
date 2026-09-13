@echo off
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 goto :failed
where node >nul 2>nul
if errorlevel 1 goto :missingnode
where cargo >nul 2>nul
if errorlevel 1 goto :missingrust
if exist "node_modules\@tauri-apps\cli\tauri.js" goto :start
echo 正在安装依赖，首次运行需要联网，请稍等...
call npm ci
if errorlevel 1 goto :failed
:start
call npm start
if errorlevel 1 goto :failed
popd
exit /b 0
:missingnode
echo 请先安装 Node.js 22.12 或更高版本，再重新运行本文件。
echo 下载地址：https://nodejs.org/
pause
exit /b 1
:missingrust
echo 源码运行需要 Rust stable MSVC 和 Visual Studio C++ Build Tools。
echo 直接使用 release 中的安装版或便携版无需开发环境。
pause
exit /b 1
:failed
echo 启动失败，请查看上方信息或 README.md 中的说明。
pause
exit /b 1
