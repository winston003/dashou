!include LogicLib.nsh
!include StrFunc.nsh
${StrTrimNewLines}

; Stop only the running Dashou instance before NSIS replaces bundled runtime
; files. The app handles --prepare-update through the single-instance bridge,
; so the existing process stops its own Node/cloudflared process tree instead
; of the installer guessing by process name.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\Dashou.exe" 0 dashou_prepare_update_legacy
    nsExec::ExecToLog '"$INSTDIR\Dashou.exe" --prepare-update'
    Pop $0
    Sleep 1000
  dashou_prepare_update_legacy:
  ; rc.10 and older do not understand --prepare-update. Their lock file
  ; contains the PID of the Dashou-owned Node process, so use that exact PID
  ; as a compatibility fallback instead of killing every cloudflared.exe.
  ReadEnvStr $0 APPDATA
  StrCpy $1 "$0\studio.warmbyte.dashou\state\serve.lock\pid"
  IfFileExists "$1" 0 dashou_prepare_update_done
    FileOpen $2 "$1" r
    FileRead $2 $3
    FileClose $2
    ${StrTrimNewLines} $3 "$3"
    IntOp $4 $3 + 0
    ${If} $4 > 0
      nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /PID $4 /T /F'
      Pop $5
      Sleep 750
    ${EndIf}
  dashou_prepare_update_done:
  ; A few older runtimes spawned cloudflared outside the process tree that
  ; owns serve.lock. Stop only binaries whose full executable path is inside
  ; this Dashou installation; never kill an unrelated cloudflared process.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -ieq ''Dashou.exe'' -and $$_.ExecutablePath -eq ''$INSTDIR\Dashou.exe'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $6
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -ieq ''cloudflared.exe'' -and ($$_.ExecutablePath -eq ''$INSTDIR\_up\vendor\cloudflared\cloudflared.exe'' -or $$_.ExecutablePath -eq ''$INSTDIR\vendor\cloudflared\cloudflared.exe'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $7
  Sleep 1000
!macroend
