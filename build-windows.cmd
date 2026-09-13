@echo off
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 goto :failed
where node >nul 2>nul
if errorlevel 1 goto :missingnode
where cargo >nul 2>nul
if errorlevel 1 goto :missingrust
echo 正在准备 Windows 构建依赖...
call npm ci
if errorlevel 1 goto :failed
call npm run check
if errorlevel 1 goto :failed
call npm test
if errorlevel 1 goto :failed
call npm run test:native
if errorlevel 1 goto :failed
call npm run build:win
if errorlevel 1 goto :failed
echo.
echo 构建完成！安装版和便携版已生成在 release 文件夹。
popd
pause
exit /b 0
:missingnode
echo 请先安装 Node.js 22.12 或更高版本。
pause
exit /b 1
:failed
echo 构建失败，请查看上方信息。
pause
exit /b 1
:missingrust
echo 请先安装 Rust stable MSVC 和 Visual Studio C++ Build Tools。
pause
exit /b 1
