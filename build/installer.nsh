; DeepSeek Harness Desktop NSIS 定制脚本（由 electron-builder 自动 include）
; 卸载时询问是否清理 userData：内置运行时（~340MB）、日志与设置
; 路径与 electron/main.ts 中 app.setPath('userData') 保持一致

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除应用数据？$\n$\n\
包含内置运行时（约 340MB）、日志与设置，位于：$\n\
$APPDATA\deepseek-harness-desktop$\n$\n\
若以后还可能重装本应用，可选择“否”保留（重装后无需重新解压运行时）。" /SD IDNO IDYES del_data IDNO skip_del
  del_data:
    RMDir /r "$APPDATA\deepseek-harness-desktop"
  skip_del:
!macroend
