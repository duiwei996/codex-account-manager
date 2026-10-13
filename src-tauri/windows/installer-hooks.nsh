; Preserve renamed desktop shortcuts and never recreate one during an update.
; Only links targeting this installation are considered; unrelated links stay intact.
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $0
  Push $1
  Push $2
  Push $3
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATER" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ${If} $UpdateMode = 1
    StrCpy $NoShortcutMode 1
    ; Tauri otherwise creates shortcuts unconditionally when migrating from MSI.
    StrCpy $WixMode 0
  ${EndIf}
  FindFirst $R0 $R1 "$DESKTOP\*.lnk"
  ${DoWhile} $R1 != ""
    !insertmacro IsShortcutTarget "$DESKTOP\$R1" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R2
    ${If} $R2 <> 1
    ${AndIf} $OldMainBinaryName != ""
      !insertmacro IsShortcutTarget "$DESKTOP\$R1" "$INSTDIR\$OldMainBinaryName"
      Pop $R2
    ${EndIf}
    ${If} $R2 = 1
      StrCpy $NoShortcutMode 1
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $R3 0
  FindFirst $R0 $R1 "$DESKTOP\*.lnk"
  ${DoWhile} $R1 != ""
    !insertmacro IsShortcutTarget "$DESKTOP\$R1" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R2
    ${If} $R2 <> 1
    ${AndIf} $OldMainBinaryName != ""
      !insertmacro IsShortcutTarget "$DESKTOP\$R1" "$INSTDIR\$OldMainBinaryName"
      Pop $R2
      ${If} $R2 = 1
        !insertmacro SetShortcutTarget "$DESKTOP\$R1" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${EndIf}
    ${EndIf}
    ${If} $R2 = 1
    ${AndIf} $R1 != "${PRODUCTNAME}.lnk"
      StrCpy $R3 1
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  ${If} $R3 = 1
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R2
    ${If} $R2 = 1
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
