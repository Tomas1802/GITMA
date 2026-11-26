; Explorer right-click "Open in GITMA" on folders, plus an App Paths entry so other apps
; (e.g. MABO) can launch `gitma.exe` by name through ShellExecute / `start`.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\gitma.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GITMA" "" "Open in GITMA"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GITMA" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GITMA\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GITMA" "" "Open in GITMA"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GITMA" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GITMA\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\gitma.exe"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GITMA"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GITMA"
!macroend
