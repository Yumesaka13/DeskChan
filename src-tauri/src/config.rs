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
    /// Icons contained within this cell
    pub icons: Vec<DesktopIcon>,
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

/// Load config from a TOML file path.
pub fn load_config(path: &std::path::Path) -> Result<DeskConfig, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let cfg: DeskConfig = toml::from_str(&content)?;
    Ok(cfg)
}

/// Save config to a TOML file path.
pub fn save_config(
    path: &std::path::Path,
    cfg: &DeskConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let content = toml::to_string_pretty(cfg)?;
    std::fs::write(path, content)?;
    Ok(())
}

/// Check whether a file extension belongs to an executable / application.
pub fn is_app_extension(ext: &str) -> bool {
    matches!(ext.to_lowercase().as_str(), "exe" | "lnk" | "bat" | "cmd" | "msc")
}
