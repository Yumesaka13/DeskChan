#[cfg(target_os = "windows")]
mod windows {
    use reqwest::{Client, Url};
    use semver::Version;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::{
        io::{self, Write},
        path::{Path, PathBuf},
        process::Command,
        time::Duration,
    };
    use tauri::utils::{config::BundleType, platform::bundle_type};
    use tauri::Manager;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const REPO: &str = "Yumesaka13/DeskChan";
    const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;

    #[derive(Deserialize)]
    struct Asset {
        name: String,
        size: u64,
        digest: Option<String>,
    }

    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
        assets: Vec<Asset>,
    }

    #[derive(Clone, Copy)]
    enum Installer {
        Exe,
        Msi,
    }

    impl Installer {
        fn for_current_install() -> Result<Self, String> {
            match bundle_type() {
                Some(BundleType::Msi) => return Ok(Self::Msi),
                Some(BundleType::Nsis) => return Ok(Self::Exe),
                _ => {}
            }
            let exe = std::env::current_exe()
                .and_then(|path| path.canonicalize())
                .map_err(|err| err.to_string())?;
            // Binaries packaged by older Tauri versions lack a bundle marker.
            // The NSIS bundle still puts its uninstaller beside the app.
            if exe.with_file_name("uninstall.exe").is_file() {
                return Ok(Self::Exe);
            }
            // WiX records its install directory for the current user.
            let msi_home: Option<String> = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(r"Software\deskchan\DeskChan")
                .and_then(|key| key.get_value("InstallDir"))
                .ok();
            if let Some(home) = msi_home {
                let home = Path::new(&home).canonicalize().ok();
                if home.as_deref().is_some_and(|path| exe.starts_with(path)) {
                    return Ok(Self::Msi);
                }
            }
            Ok(Self::Exe)
        }

        fn asset_prefix(self, version: &Version) -> Result<String, String> {
            let arch = match std::env::consts::ARCH {
                "x86_64" => "x64",
                "aarch64" => "arm64",
                "x86" => "x86",
                _ => return Err("unsupported Windows installer architecture".into()),
            };
            Ok(format!("DeskChan_{version}_{arch}"))
        }

        fn extension(self) -> &'static str {
            match self {
                Self::Exe => "exe",
                Self::Msi => "msi",
            }
        }

        fn asset_name_matches(self, name: &str, prefix: &str) -> bool {
            match self {
                Self::Exe => name.strip_prefix(prefix) == Some("-setup.exe"),
                Self::Msi => name.strip_prefix(prefix).is_some_and(|suffix| {
                    suffix.starts_with('_')
                        && suffix.ends_with(".msi")
                        && !suffix.contains(['/', '\\'])
                }),
            }
        }

        fn launch(self, path: &Path) -> Result<(), String> {
            match self {
                Self::Exe => Command::new(path)
                    .args(["/P", "/UPDATE", "/R"])
                    .spawn()
                    .map(drop),
                Self::Msi => {
                    let root = std::env::var_os("SystemRoot").ok_or("SystemRoot is missing")?;
                    Command::new(PathBuf::from(root).join(r"System32\msiexec.exe"))
                        .arg("/i")
                        .arg(path)
                        .args(["/passive", "/norestart", "AUTOLAUNCHAPP=True"])
                        .spawn()
                        .map(drop)
                }
            }
            .map_err(|err| err.to_string())
        }
    }

    struct Update {
        tag: String,
        version: Version,
        installer: Installer,
        asset: Asset,
        digest: String,
    }

    fn verified_digest(asset: &Asset) -> Result<&str, String> {
        let digest = asset
            .digest
            .as_deref()
            .and_then(|value| value.strip_prefix("sha256:"));
        match digest {
            Some(digest) if digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()) => {
                Ok(digest)
            }
            _ => Err("GitHub did not provide a valid installer digest".into()),
        }
    }

    fn client() -> Result<Client, String> {
        Client::builder()
            .user_agent(concat!("DeskChan/", env!("CARGO_PKG_VERSION")))
            .https_only(true)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|err| err.to_string())
    }

    fn select_update(
        release: Release,
        current: &Version,
        installer: Installer,
    ) -> Result<Option<Update>, String> {
        let tag = release.tag_name;
        let version = Version::parse(tag.strip_prefix('v').unwrap_or(&tag))
            .map_err(|err| format!("invalid release version: {err}"))?;
        if !version.pre.is_empty() || !version.cmp_precedence(current).is_gt() {
            return Ok(None);
        }
        let prefix = installer.asset_prefix(&version)?;
        let asset = release
            .assets
            .into_iter()
            .find(|asset| installer.asset_name_matches(&asset.name, &prefix))
            .ok_or("the release does not have a compatible Windows installer")?;
        if !(1..=MAX_INSTALLER_BYTES).contains(&asset.size) {
            return Err("invalid installer size".into());
        }
        let digest = verified_digest(&asset)?.to_ascii_lowercase();
        Ok(Some(Update {
            tag,
            version,
            installer,
            asset,
            digest,
        }))
    }

    async fn latest(client: &Client, current: &Version) -> Result<Option<Update>, String> {
        let response = client
            .get(format!(
                "https://api.github.com/repos/{REPO}/releases/latest"
            ))
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let release = response
            .error_for_status()
            .map_err(|err| err.to_string())?
            .json::<Release>()
            .await
            .map_err(|err| err.to_string())?;
        select_update(release, current, Installer::for_current_install()?)
    }

    pub async fn check(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        Ok(latest(&client()?, &app.package_info().version)
            .await?
            .map(|update| update.version.to_string()))
    }

    pub async fn download_and_launch(app: &tauri::AppHandle, version: &str) -> Result<(), String> {
        let client = client()?;
        let update = latest(&client, &app.package_info().version)
            .await?
            .filter(|update| update.version.to_string() == version)
            .ok_or("the selected update has changed; check for updates again")?;
        // Build the asset URL inside this repository instead of executing a
        // download URL supplied by the renderer or found in release notes.
        let mut url = Url::parse(&format!("https://github.com/{REPO}/releases/download/"))
            .map_err(|err| err.to_string())?;
        url.path_segments_mut()
            .map_err(|_| "invalid release URL")?
            .pop_if_empty()
            .push(&update.tag)
            .push(&update.asset.name);
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| err.to_string())?;

        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|err| err.to_string())?
            .join("updates");
        std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        // Failed and interrupted downloads never leave a runnable installer
        // behind. Keep only verified files the installer is about to open.
        let mut download = tempfile::Builder::new()
            .prefix("DeskChan-")
            .suffix(".download")
            .tempfile_in(dir)
            .map_err(|err| err.to_string())?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
            bytes += chunk.len() as u64;
            if bytes > update.asset.size {
                return Err("installer exceeded the expected size".into());
            }
            hash.update(&chunk);
            download.write_all(&chunk).map_err(|err| err.to_string())?;
        }
        if bytes != update.asset.size || format!("{:x}", hash.finalize()) != update.digest {
            return Err("installer integrity check failed".into());
        }
        launch_verified(download, &update)
    }

    fn launch_verified(download: tempfile::NamedTempFile, update: &Update) -> Result<(), String> {
        download
            .as_file()
            .sync_all()
            .map_err(|err| err.to_string())?;
        let installer = download.path().with_extension(update.installer.extension());
        let file = download
            .persist_noclobber(&installer)
            .map_err(|err| err.to_string())?;
        drop(file);
        update.installer.launch(&installer).inspect_err(|_| {
            let _ = std::fs::remove_file(installer);
        })
    }

    pub fn clean_cache(app: &tauri::AppHandle) -> io::Result<()> {
        let Ok(dir) = app.path().app_cache_dir() else {
            return Ok(());
        };
        let dir = dir.join("updates");
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if !entry.file_name().to_string_lossy().starts_with("DeskChan-") {
                    continue;
                }
                let age = entry.metadata()?.modified()?.elapsed().ok();
                if entry.file_type()?.is_file()
                    && age.is_some_and(|age| age > Duration::from_secs(86400))
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn stable_updates_require_a_matching_verified_installer() {
            let current = Version::new(0, 2, 0);
            let version = Version::new(0, 10, 0);
            let prefix = Installer::Exe.asset_prefix(&version).unwrap();
            let release = |tag: &str, name: String, digest: Option<String>| Release {
                tag_name: tag.to_string(),
                assets: vec![Asset {
                    name,
                    size: 10,
                    digest,
                }],
            };
            let correct_name = format!("{prefix}-setup.exe");
            let digest = Some(format!("sha256:{}", "a".repeat(64)));
            let update = select_update(
                release("v0.10.0", correct_name.clone(), digest.clone()),
                &current,
                Installer::Exe,
            )
            .unwrap()
            .unwrap();
            assert_eq!(update.version, version);
            assert!(select_update(
                release("0.2.0", correct_name.clone(), None),
                &current,
                Installer::Exe
            )
            .unwrap()
            .is_none());
            assert!(select_update(
                release("0.10.0-beta.1", correct_name.clone(), None),
                &current,
                Installer::Exe
            )
            .unwrap()
            .is_none());
            assert!(select_update(
                release("0.10.0", correct_name, None),
                &current,
                Installer::Exe
            )
            .is_err());
            assert!(select_update(
                release("0.10.0", format!("{prefix}_en-US.msi"), digest),
                &current,
                Installer::Exe
            )
            .is_err());
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows::{check, clean_cache, download_and_launch};

#[cfg(not(target_os = "windows"))]
pub async fn check(_app: &tauri::AppHandle) -> Result<Option<String>, String> {
    Err("automatic updates are only supported on Windows".into())
}

#[cfg(not(target_os = "windows"))]
pub async fn download_and_launch(_app: &tauri::AppHandle, _version: &str) -> Result<(), String> {
    Err("automatic updates are only supported on Windows".into())
}
