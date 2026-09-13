; Tauri's default silent install/uninstall terminates every matching process.
; SideTask keeps drafts in memory, so require an explicit normal exit instead.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!else
  !error "Review SideTask's shutdown protection after updating the NSIS template."
!endif

!macro CheckIfAppIsRunning executableName productName
  nsis_tauri_utils::FindProcessCurrentUser "${executableName}"
  Pop $R0
  ${If} $R0 = 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "请先保存草稿，并从托盘退出 ${productName}，再重新运行安装或卸载程序。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
