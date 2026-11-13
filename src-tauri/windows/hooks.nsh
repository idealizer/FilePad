!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FilePad"
  ReadRegStr $R0 HKCU "Software\Classes\Directory\shell" ""
  StrCmp $R0 "FilePad" filepad_clear_dir filepad_keep_dir
  filepad_clear_dir:
    DeleteRegValue HKCU "Software\Classes\Directory\shell" ""
  filepad_keep_dir:
  DeleteRegKey HKCU "Software\Classes\Drive\shell\FilePad"
  ReadRegStr $R0 HKCU "Software\Classes\Drive\shell" ""
  StrCmp $R0 "FilePad" filepad_clear_drive filepad_keep_drive
  filepad_clear_drive:
    DeleteRegValue HKCU "Software\Classes\Drive\shell" ""
  filepad_keep_drive:
  DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; An empty icon location leaves the shortcut with a blank icon.
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
!macroend
