use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CELLS: usize = 256;
const MAX_SUB_CELLS: usize = 1024;
const MAX_ICONS: usize = 8192;
const MAX_TEXT_CHARS: usize = 4096;

/// A desktop shortcut icon within a cell.
/// Files always stay in the desktop folder; we just track their paths.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DesktopIcon {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// Display name
    pub name: String,
    /// Absolute path to the target file / executable (on the actual desktop)
    pub path: String,
    /// Optional custom icon path; falls back to system icon if absent
    pub icon_path: Option<String>,
    /// X position in free arrangement mode (0 = auto-grid)
    #[serde(default)]
    pub pos_x: f64,
    /// Y position in free arrangement mode (0 = auto-grid)
    #[serde(default)]
    pub pos_y: f64,
}

/// Layout mode for icons within a cell.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub enum CellLayout {
    /// Icons arranged in a vertical list
    List,
    /// Icons auto-arranged in a grid
    Grid,
}

/// Positioning and size of a cell on screen (pixel units).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct CellRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Sizing mode of the sub-box tab strip.
#[derive(Debug, Clone, Serialize, Deserialize, Default, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub enum SubStyle {
    /// Tabs hug their labels (wrap to multiple rows when needed)
    #[default]
    Compact,
    /// Tabs stretch equally to fill the cell width (single row)
    Stretch,
}

/// A tabbed sub-box inside a cell, rendered as a tab strip right under the
/// title bar. One nesting level only - sub-boxes hold icons, not more boxes.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct SubCell {
    pub id: String,
    /// Tab label
    pub title: String,
    /// Icons contained in this sub-box
    #[serde(default)]
    pub icons: Vec<DesktopIcon>,
}

/// A desktop cell (fence/box) that holds icons.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct Cell {
    pub id: String,
    /// Display title at the top of the cell
    pub title: String,
    /// Screen position and dimensions
    pub rect: CellRect,
    /// Background color (rgba hex or named). None = use theme default.
    pub background_color: Option<String>,
    /// Opacity (0.0-1.0)
    pub opacity: f64,
    /// Layout mode for icons inside this cell
    pub layout: CellLayout,
    /// Per-cell icon sorting field: name, type, or modified.
    #[serde(default = "default_sort_field")]
    pub sort_field: String,
    /// Per-cell sort direction: asc or desc.
    #[serde(default = "default_sort_direction")]
    pub sort_direction: String,
    /// Rolled up to the title bar only (Coodesker-style double-click collapse)
    #[serde(default)]
    pub collapsed: bool,
    /// When collapsed, hovering temporarily unrolls the cell (Coodesker's
    /// second collapse mode, toggled from the cell's title bar)
    #[serde(default = "default_true")]
    pub hover_expand: bool,
    /// Icons contained within this cell (the implicit first tab)
    pub icons: Vec<DesktopIcon>,
    /// Tabbed sub-boxes shown under the title bar
    #[serde(default)]
    pub sub_cells: Vec<SubCell>,
    /// Selected tab: a sub-cell id, or None for the cell's own icons
    #[serde(default)]
    pub active_sub: Option<String>,
    /// How the sub-box tabs size themselves
    #[serde(default)]
    pub sub_style: SubStyle,
    /// Whether this cell shows its title bar while expanded (a rolled-up
    /// cell always shows the bar - it is all there is to grab)
    #[serde(default = "default_true")]
    pub show_title: bool,
}

fn default_true() -> bool {
    true
}

fn default_sort_field() -> String {
    "name".into()
}
fn default_sort_direction() -> String {
    "asc".into()
}

/// Top-level desktop configuration saved as TOML.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DeskConfig {
    /// Version for future migration
    pub version: u32,
    /// All fenced cells on the desktop
    pub cells: Vec<Cell>,
    /// Free-floating icons (not in any cell), arranged in a grid on the desktop
    #[serde(default)]
    pub free_icons: Vec<DesktopIcon>,
    /// Absolute paths of icons that must remain free when auto-organizing.
    #[serde(default)]
    pub excluded_from_organize: Vec<String>,
    /// Use DeskChan's Fluent file context menu instead of the Shell menu.
    #[serde(default = "default_true")]
    pub use_styled_file_menu: bool,
    /// Whether file labels include their filename extension.
    #[serde(default = "default_true")]
    pub show_file_extensions: bool,
    /// Auto-arrange free icons in a grid (true) or allow free placement (false)
    #[serde(default)]
    pub auto_arrange: bool,
    /// Snap free icons to grid positions when dragged
    #[serde(default)]
    pub snap_to_grid: bool,
    /// Theme: "light", "dark", "auto"
    pub theme: String,
    /// White desktop overlay opacity. A small non-zero value keeps WebView2
    /// receiving drag events while allowing users to brighten dark wallpapers.
    #[serde(default = "default_desktop_overlay_opacity")]
    pub desktop_overlay_opacity: f64,
}

fn default_desktop_overlay_opacity() -> f64 {
    0.01
}

impl Default for DeskConfig {
    fn default() -> Self {
        Self {
            version: 3,
            cells: Vec::new(),
            free_icons: Vec::new(),
            excluded_from_organize: Vec::new(),
            use_styled_file_menu: true,
            show_file_extensions: true,
            auto_arrange: true,
            snap_to_grid: true,
            theme: "auto".to_string(),
            desktop_overlay_opacity: default_desktop_overlay_opacity(),
        }
    }
}

/// A single desktop directory entry, as returned by `scan_desktop`.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DesktopEntry {
    /// Absolute path of the file / folder
    pub path: String,
    /// Whether the entry is a directory (affects display-name derivation)
    pub is_dir: bool,
    /// Last modification time as milliseconds since the Unix epoch.
    pub modified_at_millis: f64,
}

/// Result of scanning the desktop folders. `dirs` lets the frontend decide
/// which config icons are desktop-owned (and thus subject to auto-removal
/// when the underlying file disappears).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DesktopScan {
    /// The scanned desktop folders (user + public)
    pub dirs: Vec<String>,
    /// All visible entries across those folders
    pub entries: Vec<DesktopEntry>,
}

/// Load and validate config from a TOML file path.
pub fn load_config(path: &std::path::Path) -> Result<DeskConfig, Box<dyn std::error::Error>> {
    if std::fs::metadata(path)?.len() > MAX_CONFIG_BYTES {
        return Err("configuration file is too large".into());
    }
    let content = std::fs::read_to_string(path)?;
    let cfg: DeskConfig = toml::from_str(&content)?;
    validate_config(&cfg).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    Ok(cfg)
}

pub fn validate_config(cfg: &DeskConfig) -> Result<(), String> {
    if cfg.version > 3 {
        return Err("configuration version is newer than this application".into());
    }
    if !matches!(cfg.theme.as_str(), "light" | "dark" | "auto") {
        return Err("unsupported theme".into());
    }
    if !cfg.desktop_overlay_opacity.is_finite()
        || !(0.01..=0.5).contains(&cfg.desktop_overlay_opacity)
    {
        return Err("desktop overlay opacity must be between 0.01 and 0.5".into());
    }
    if cfg.cells.len() > MAX_CELLS {
        return Err("configuration contains too many cells".into());
    }

    let mut ids = HashSet::new();
    let mut sub_count = 0usize;
    let mut icon_count = cfg.free_icons.len();
    for icon in &cfg.free_icons {
        validate_icon(icon, &mut ids)?;
    }
    if cfg.excluded_from_organize.len() > MAX_ICONS
        || cfg
            .excluded_from_organize
            .iter()
            .any(|path| path.is_empty() || path.chars().count() > MAX_TEXT_CHARS)
    {
        return Err("organize exclusions are invalid".into());
    }
    for cell in &cfg.cells {
        validate_id_and_text(&cell.id, &cell.title, &mut ids)?;
        if !cell.opacity.is_finite() || !(0.0..=1.0).contains(&cell.opacity) {
            return Err("cell opacity must be between zero and one".into());
        }
        if !matches!(cell.sort_field.as_str(), "name" | "type" | "modified")
            || !matches!(cell.sort_direction.as_str(), "asc" | "desc")
        {
            return Err("cell sort settings are invalid".into());
        }
        let rect = &cell.rect;
        if ![rect.x, rect.y, rect.width, rect.height]
            .into_iter()
            .all(f64::is_finite)
            || rect.width <= 0.0
            || rect.height <= 0.0
        {
            return Err("cell geometry is invalid".into());
        }
        icon_count = icon_count.saturating_add(cell.icons.len());
        for icon in &cell.icons {
            validate_icon(icon, &mut ids)?;
        }
        sub_count = sub_count.saturating_add(cell.sub_cells.len());
        for sub in &cell.sub_cells {
            validate_id_and_text(&sub.id, &sub.title, &mut ids)?;
            icon_count = icon_count.saturating_add(sub.icons.len());
            for icon in &sub.icons {
                validate_icon(icon, &mut ids)?;
            }
        }
        if let Some(active) = &cell.active_sub {
            if !cell.sub_cells.iter().any(|sub| &sub.id == active) {
                return Err("active sub-cell does not exist".into());
            }
        }
    }
    if sub_count > MAX_SUB_CELLS || icon_count > MAX_ICONS {
        return Err("configuration contains too many items".into());
    }
    Ok(())
}

fn validate_icon(icon: &DesktopIcon, ids: &mut HashSet<String>) -> Result<(), String> {
    validate_id_and_text(&icon.id, &icon.name, ids)?;
    if !icon.pos_x.is_finite() || !icon.pos_y.is_finite() {
        return Err("icon position is invalid".into());
    }
    if icon.path.chars().count() > MAX_TEXT_CHARS
        || icon
            .icon_path
            .as_ref()
            .is_some_and(|path| path.chars().count() > MAX_TEXT_CHARS)
    {
        return Err("icon path is too long".into());
    }
    Ok(())
}

fn validate_id_and_text(id: &str, text: &str, ids: &mut HashSet<String>) -> Result<(), String> {
    if id.is_empty() || id.chars().count() > 128 || !ids.insert(id.to_string()) {
        return Err("configuration IDs must be non-empty and unique".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err("configuration text is too long".into());
    }
    Ok(())
}

/// Save config to a TOML file path. Atomic (temp file + rename): a reader -
/// including the next app launch - can never observe a truncated file, even
/// if two writers race or the process dies mid-write.
pub fn save_config(
    path: &std::path::Path,
    cfg: &DeskConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let content = toml::to_string_pretty(cfg)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, content)?;
    // Same-volume rename replaces atomically on Windows (MOVEFILE_REPLACE_EXISTING)
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Check whether a file extension belongs to an executable / application.
pub fn is_app_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "exe" | "lnk" | "bat" | "cmd" | "msc"
    )
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn rejects_duplicate_ids_and_invalid_geometry() {
        let mut cfg = DeskConfig::default();
        let icon = DesktopIcon {
            id: "duplicate".into(),
            name: "file".into(),
            path: r"C:\file.txt".into(),
            icon_path: None,
            pos_x: 0.0,
            pos_y: 0.0,
        };
        cfg.free_icons = vec![icon.clone(), icon];
        assert!(validate_config(&cfg).is_err());

        let mut cfg = DeskConfig::default();
        cfg.cells.push(Cell {
            id: "cell".into(),
            title: "cell".into(),
            rect: CellRect {
                x: 0.0,
                y: 0.0,
                width: -1.0,
                height: 10.0,
            },
            background_color: None,
            opacity: 0.5,
            layout: CellLayout::Grid,
            sort_field: "name".into(),
            sort_direction: "asc".into(),
            collapsed: false,
            hover_expand: false,
            icons: Vec::new(),
            sub_cells: Vec::new(),
            active_sub: None,
            sub_style: SubStyle::Compact,
            show_title: true,
        });
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_unknown_theme_and_future_version() {
        let cfg = DeskConfig {
            theme: "unknown".into(),
            ..DeskConfig::default()
        };
        assert!(validate_config(&cfg).is_err());
        let cfg = DeskConfig {
            version: 4,
            ..DeskConfig::default()
        };
        assert!(validate_config(&cfg).is_err());
    }
}
