use super::PlatformError;
use super::process::{ProcessSnapshot, process_snapshot, same_process_instance};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{ObservedProcessTree, process_snapshots};
#[cfg(target_os = "windows")]
use super::windows_process;

pub fn terminate_process_instance(
    expected: &ProcessSnapshot,
    _force: bool,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
        let current = match process_snapshot(expected.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        if !same_process_instance(expected, &current) {
            return Ok(());
        }
        let _ = windows_process::terminate_process_instance(
            expected.id,
            expected.started_at_micros,
            1,
        )?;
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let signal = if _force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new(expected.clone())
            .signal_processes(std::slice::from_ref(expected), signal)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected, _force);
        Err(PlatformError::Unsupported(
            "exact process termination requires Windows, macOS, or Linux",
        ))
    }
}

pub fn terminate_process_group_instance(
    expected_root: &ProcessSnapshot,
    force: bool,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
        terminate_process_instance(expected_root, force)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let current = match process_snapshot(expected_root.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        if !same_process_instance(expected_root, &current) {
            return Ok(());
        }
        let group_members = process_snapshots()?
            .into_iter()
            .filter(|process| {
                process.process_group_id == current.process_group_id
                    && process.started_at_micros >= current.started_at_micros
            })
            .collect::<Vec<_>>();
        let signal = if force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new_with_process_group(
            current.clone(),
            Some(current.process_group_id),
            Some(current.started_at_micros),
        )
        .signal_processes(&group_members, signal)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected_root, force);
        Err(PlatformError::Unsupported(
            "exact process-group termination requires Windows, macOS, or Linux",
        ))
    }
}

/// Terminates whatever listens on a loopback TCP port.
///
/// A Desktop Controller that outlives its Launcher keeps answering on the Control
/// endpoint forever. The Launcher reaps it before starting, because waiting for a
/// dead runtime to exit deadlocks every later launch.
///
/// Returns `Ok(false)` when no listener could be identified; callers treat that as
/// "nothing to reap" rather than as a failure.
pub fn terminate_port_listener(port: u16, force: bool) -> Result<bool, PlatformError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let lsof = if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        };
        let filter = format!("-iTCP:{port}");
        let output = match std::process::Command::new(lsof)
            .args(["-nP", filter.as_str(), "-sTCP:LISTEN", "-t"])
            .output()
        {
            Ok(output) => output,
            // Images without lsof simply skip reaping.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(PlatformError::Io(error)),
        };
        if !output.status.success() {
            // lsof exits non-zero when the filter matches nothing.
            return Ok(false);
        }
        let mut terminated = false;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Ok(process_id) = line.trim().parse::<u32>() else {
                continue;
            };
            if process_id == std::process::id() {
                continue;
            }
            let snapshot = match process_snapshot(process_id) {
                Ok(snapshot) => snapshot,
                Err(PlatformError::NotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            terminate_process_instance(&snapshot, force)?;
            terminated = true;
        }
        Ok(terminated)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (port, force);
        // Windows reaps stale Launchers through `stop_stale_launcher`, keyed by the
        // Descriptor PID; an unowned Controller port never blocks a new launch.
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::terminate_port_listener;

    #[test]
    fn reports_no_listener_for_a_port_nobody_owns() {
        // Port 1 is privileged and never a codexhost Control endpoint, so the reap
        // helper must answer "nothing to clean up" instead of failing.
        assert!(!terminate_port_listener(1, false).expect("probe unowned port"));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::{process_snapshot, terminate_process_instance};

    #[test]
    fn refuses_to_terminate_a_reused_windows_process_id() {
        let mut recycled = process_snapshot(std::process::id()).expect("current process snapshot");
        recycled.started_at_micros = recycled.started_at_micros.saturating_add(1);
        terminate_process_instance(&recycled, true).expect("reject recycled process instance");
        assert!(process_snapshot(std::process::id()).is_ok());
    }
}
