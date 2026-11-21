use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../bindings/")]
pub enum StartupMode {
    Off,
    Normal,
    Elevated,
}

#[cfg(target_os = "windows")]
mod windows {
    use super::StartupMode;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::Deserialize;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    #[derive(Deserialize)]
    struct TaskStatus {
        mode: StartupMode,
        elevated: bool,
        sid: String,
    }

    fn powershell() -> Result<Command, String> {
        let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot is missing")?;
        let executable = std::path::PathBuf::from(system_root)
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let mut command = Command::new(executable);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
            ])
            .creation_flags(CREATE_NO_WINDOW);
        Ok(command)
    }

    fn encode_script(script: &str) -> String {
        STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
    }

    fn run_script(script: &str) -> Result<Vec<u8>, String> {
        let output = powershell()?
            .arg(encode_script(script))
            .output()
            .map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            let details = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Task Scheduler command failed ({}): {}",
                output.status,
                details.trim()
            ))
        }
    }

    // Task Scheduler remains the source of truth, including changes made in
    // its UI. Tasks are per account and only run in an interactive session.
    const TASK_SETUP: &str = r#"
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$name = "DeskChan-$sid"
$task = $null
foreach ($entry in $folder.GetTasks(1)) {
    if ($entry.Name -eq $name) { $task = $entry; break }
}
"#;

    fn task_status() -> Result<TaskStatus, String> {
        let output = run_script(&format!(
            "{TASK_SETUP}{}",
            r#"
$elevated = $null -ne $task -and $task.Definition.Principal.RunLevel -eq 1
$mode = if ($null -eq $task -or !$task.Enabled) { 'off' }
        elseif ($elevated) { 'elevated' }
        else { 'normal' }
@{ mode = $mode; elevated = $elevated; sid = $sid } | ConvertTo-Json -Compress
"#
        ))?;
        serde_json::from_slice(&output).map_err(|err| err.to_string())
    }

    pub fn get_mode() -> Result<StartupMode, String> {
        Ok(task_status()?.mode)
    }

    pub fn set_mode(mode: StartupMode) -> Result<(), String> {
        let status = task_status()?;
        let requested_mode = match mode {
            StartupMode::Off => "off",
            StartupMode::Normal => "normal",
            StartupMode::Elevated => "elevated",
        };
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let exe = STANDARD.encode(exe.to_str().ok_or("invalid executable path")?);
        if !status.sid.starts_with("S-")
            || !status.sid[2..]
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-')
        {
            return Err("invalid Windows account SID".into());
        }
        let sid = status.sid;
        let script = format!(
            "{TASK_SETUP}\n$owner = '{sid}'\n$mode = '{requested_mode}'\n$exe = '{exe}'\n{}",
            r#"
if ($sid -ne $owner) { throw 'Use the same Windows account to approve startup changes.' }
if ($mode -eq 'off') {
    if ($null -ne $task) { $folder.DeleteTask($name, 0) }
    exit 0
}
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.Description = 'Start DeskChan when this user signs in.'
$definition.Principal.UserId = $sid
$definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
$definition.Principal.RunLevel = [int]($mode -eq 'elevated')
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
$trigger = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON
$trigger.UserId = $sid
$action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
$action.Path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($exe))
$action.WorkingDirectory = [IO.Path]::GetDirectoryName($action.Path)
$null = $folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $null)
"#
        );
        if status.elevated || matches!(mode, StartupMode::Elevated) {
            // Elevate only the task change. DeskChan stays running at its
            // current integrity level and UAC cancellation leaves the task intact.
            let script = encode_script(&script);
            run_script(&format!(
                r#"
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {{
    & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{script}'))))
}} else {{
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoLogo -NoProfile -NonInteractive -EncodedCommand {script}'
    exit $process.ExitCode
}}
"#
            ))?;
        } else {
            run_script(&script)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub use windows::{get_mode, set_mode};

#[cfg(not(target_os = "windows"))]
pub fn get_mode() -> Result<StartupMode, String> {
    Err("startup settings are only supported on Windows".into())
}

#[cfg(not(target_os = "windows"))]
pub fn set_mode(_mode: StartupMode) -> Result<(), String> {
    Err("startup settings are only supported on Windows".into())
}
