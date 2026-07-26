use serde::{Deserialize, Serialize};

/// A desktop shortcut icon within a cell.
/// Files always stay in the desktop folder; we just track their paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub enum CellLayout {
    /// Icons arranged in a vertical list
    List,
    /// Icons auto-arranged in a grid
    Grid,
}

/// Positioning and size of a cell on screen (pixel units).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct CellRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Sizing mode of the sub-box tab strip.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub enum SubStyle {
    /// Tabs hug their labels (wrap to multiple rows when needed)
    #[default]
    Compact,
    /// Tabs stretch equally to fill the cell width (single row)
    Stretch,
}

/// A tabbed sub-box inside a cell, rendered as a tab strip right under the
/// title bar. One nesting level only — sub-boxes hold icons, not more boxes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct Cell {
    pub id: String,
    /// Display title at the top of the cell
    pub title: String,
    /// Screen position and dimensions
    pub rect: CellRect,
    /// Background color (rgba hex or named). None = use theme default.
    pub background_color: Option<String>,
    /// Opacity (0.0–1.0)
    pub opacity: f64,
    /// Layout mode for icons inside this cell
    pub layout: CellLayout,
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
}

fn default_true() -> bool {
    true
}

/// Top-level desktop configuration saved as TOML.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DeskConfig {
    /// Version for future migration
    pub version: u32,
    /// All fenced cells on the desktop
    pub cells: Vec<Cell>,
    /// Free-floating icons (not in any cell), arranged in a grid on the desktop
    #[serde(default)]
    pub free_icons: Vec<DesktopIcon>,
    /// Auto-arrange free icons in a grid (true) or allow free placement (false)
    #[serde(default)]
    pub auto_arrange: bool,
    /// Snap free icons to grid positions when dragged
    #[serde(default)]
    pub snap_to_grid: bool,
    /// Whether to show cell titles
    pub show_titles: bool,
    /// Theme: "light", "dark", "auto"
    pub theme: String,
}

impl Default for DeskConfig {
    fn default() -> Self {
        Self {
            version: 3,
            cells: Vec::new(),
            free_icons: Vec::new(),
            auto_arrange: true,
            snap_to_grid: true,
            show_titles: true,
            theme: "auto".to_string(),
        }
    }
}

/// A single desktop directory entry, as returned by `scan_desktop`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DesktopEntry {
    /// Absolute path of the file / folder
    pub path: String,
    /// Whether the entry is a directory (affects display-name derivation)
    pub is_dir: bool,
}

/// Result of scanning the desktop folders. `dirs` lets the frontend decide
/// which config icons are desktop-owned (and thus subject to auto-removal
/// when the underlying file disappears).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct DesktopScan {
    /// The scanned desktop folders (user + public)
    pub dirs: Vec<String>,
    /// All visible entries across those folders
    pub entries: Vec<DesktopEntry>,
}

/// Load config from a TOML file path.
pub fn load_config(path: &std::path::Path) -> Result<DeskConfig, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let cfg: DeskConfig = toml::from_str(&content)?;
    Ok(cfg)
}

/// Save config to a TOML file path. Atomic (temp file + rename): a reader —
/// including the next app launch — can never observe a truncated file, even
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
    matches!(ext.to_lowercase().as_str(), "exe" | "lnk" | "bat" | "cmd" | "msc")
}
