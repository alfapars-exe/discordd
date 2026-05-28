; HiChat! — NSIS installer extension
; -------------------------------------------------------------------------
; Restores the silent "kill running app before install" behavior that
; electron-builder shipped by default before v26. Without this macro, an
; install or update that runs while HiChat! is open shows a blocking
; "HiChat! is running. Click OK to close it." dialog — bad UX for the
; auto-updater flow, where the whole point is to install in the background
; and relaunch immediately.
;
; Hooked via package.json `build.nsis.include` = "build/installer.nsh".
; -------------------------------------------------------------------------

!macro customInit
  ; Force-kill any running HiChat instance (and its spawned audio-capture.exe
  ; child process) silently. /F = force, /IM = image-name match, /T = also
  ; terminate child processes.
  ;
  ; nsExec::Exec (capital E) runs the command without opening a console
  ; window. ExitCode 0 = killed, 128 = not running — both are fine, the
  ; installer should proceed in either case so we don't gate on $0.
  nsExec::Exec 'taskkill /F /IM "HiChat.exe" /T'
  Pop $0

  ; Same for the native audio capture helper. Usually killed by /T above
  ; (it's a child of HiChat.exe), but a manually-launched capture or a
  ; crashed parent can leave it orphaned.
  nsExec::Exec 'taskkill /F /IM "audio-capture.exe" /T'
  Pop $0

  ; Brief pause so Windows actually releases the file handles before
  ; NSIS tries to overwrite them. 500ms is empirically enough for
  ; SetEndOfFile / CloseHandle to complete on a typical machine.
  Sleep 500

  ; Remove legacy "Electron.lnk" shortcuts left behind by builds whose
  ; productName was still the electron-builder default ("Electron"). The
  ; current installer creates "HiChat!.lnk" from productName, but NSIS
  ; uninstallers only track shortcuts they themselves created — orphans
  ; from a prior productName persist, and Windows Search picks "Electron"
  ; as the top hit on an "electron" query because the .lnk filename is
  ; what the Start Menu shows. Delete is a no-op when the file is absent.
  Delete "$SMPROGRAMS\Electron.lnk"
  Delete "$DESKTOP\Electron.lnk"
!macroend

!macro customUnInit
  ; Mirror the install-side kill on uninstall — the user is uninstalling
  ; because they want it gone, no point showing them a running-app dialog.
  nsExec::Exec 'taskkill /F /IM "HiChat.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "audio-capture.exe" /T'
  Pop $0
  Sleep 500
!macroend
