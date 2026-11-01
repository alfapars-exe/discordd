//! Non-injected, click-through Windows HUD. Exclusive fullscreen is not supported.
#[cfg(windows)]
mod native {
    use std::{
        sync::{OnceLock, mpsc},
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::*, System::SystemServices::*, UI::WindowsAndMessaging::*,
    };
    struct State {
        target: isize,
        text: String,
    }
    static SENDER: OnceLock<mpsc::Sender<State>> = OnceLock::new();
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    pub fn update(target: String, text: String, enabled: bool) -> Result<(), String> {
        let handle = if enabled {
            target.parse::<isize>().map_err(|_| "invalid_window")?
        } else {
            0
        };
        if text.chars().count() > 180 {
            return Err("overlay_text_too_long".into());
        }
        if enabled {
            unsafe {
                let hwnd = handle as HWND;
                let mut pid = 0;
                if IsWindow(hwnd) == 0
                    || GetWindowThreadProcessId(hwnd, &mut pid) == 0
                    || pid == windows_sys::Win32::System::Threading::GetCurrentProcessId()
                {
                    return Err("invalid_overlay_target".into());
                }
            }
        }
        let sender = SENDER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<State>();
            std::thread::spawn(move || unsafe {
                let class = wide("STATIC");
                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST
                        | WS_EX_NOACTIVATE
                        | WS_EX_TOOLWINDOW
                        | WS_EX_TRANSPARENT
                        | WS_EX_LAYERED,
                    class.as_ptr(),
                    wide("").as_ptr(),
                    WS_POPUP | SS_CENTER | SS_CENTERIMAGE,
                    0,
                    0,
                    360,
                    52,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    return;
                }
                SetLayeredWindowAttributes(hwnd, 0, 220, LWA_ALPHA);
                let mut state = State {
                    target: 0,
                    text: String::new(),
                };
                loop {
                    match rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(next) => {
                            state = next;
                            SetWindowTextW(hwnd, wide(&state.text).as_ptr());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    let target = state.target as HWND;
                    let mut rect = RECT::default();
                    if state.target != 0
                        && IsWindow(target) != 0
                        && IsIconic(target) == 0
                        && GetForegroundWindow() == target
                        && GetWindowRect(target, &mut rect) != 0
                    {
                        SetWindowPos(
                            hwnd,
                            HWND_TOPMOST,
                            rect.left + 20,
                            rect.top + 55,
                            360,
                            52,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        );
                    } else {
                        ShowWindow(hwnd, SW_HIDE);
                    }
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                DestroyWindow(hwnd);
            });
            tx
        });
        sender
            .send(State {
                target: handle,
                text,
            })
            .map_err(|_| "overlay_thread_failed".into())
    }
}

pub fn update_overlay(target: String, text: String, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::update(target, text, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, text, enabled);
        Err("windows_overlay_only".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
        time::Duration,
    };
    use windows_sys::Win32::{Foundation::*, UI::WindowsAndMessaging::*};
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    #[test]
    fn rejects_invalid_windows_without_starting_capture() {
        assert!(update_overlay("not-a-window".into(), "HiChat".into(), true).is_err());
        assert!(update_overlay("0".into(), "HiChat".into(), true).is_err());
        assert!(update_overlay("0".into(), "a".repeat(181), false).is_err());
    }
    #[test]
    #[ignore = "helper process for hidden_window_runtime"]
    fn hidden_target_process() {
        if std::env::var("HICHAT_OVERLAY_HELPER").as_deref() != Ok("1") {
            return;
        }
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide("HiChat synthetic hidden target").as_ptr(),
                WS_POPUP,
                0,
                0,
                640,
                480,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            println!("target:{}", hwnd as isize);
            std::io::stdout().flush().unwrap();
            for _ in 0..1000 {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            DestroyWindow(hwnd);
        }
    }
    #[test]
    #[ignore = "creates two hidden synthetic Win32 windows; no device capture"]
    fn hidden_window_runtime() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "overlay::tests::hidden_target_process",
                "--ignored",
                "--nocapture",
            ])
            .env("HICHAT_OVERLAY_HELPER", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        let target = loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if let Some((_, id)) = line.split_once("target:") {
                break id.trim().to_owned();
            }
        };
        let title = format!("HiChat synthetic HUD {}", std::process::id());
        update_overlay(target, title.clone(), true).unwrap();
        let mut hud: HWND = std::ptr::null_mut();
        for _ in 0..100 {
            hud = unsafe { FindWindowW(std::ptr::null(), wide(&title).as_ptr()) };
            if !hud.is_null() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // Stop helper even when a runtime assertion fails.
        let _ = child.kill();
        let _ = child.wait();
        assert!(!hud.is_null(), "native HUD thread did not create a window");
        unsafe {
            assert_eq!(
                IsWindowVisible(hud),
                0,
                "background target must never show HUD"
            );
            let style = GetWindowLongPtrW(hud, GWL_EXSTYLE) as u32;
            assert_eq!(
                style & (WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW),
                WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW
            );
        }
        update_overlay(String::new(), String::new(), false).unwrap();
    }
}
