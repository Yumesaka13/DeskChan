# DeskChan — Desktop Fence Tool

A **Windows desktop organizer** inspired by [Coodesker](https://www.coodesker.com/) / Stardock Fences. DeskChan hides the native desktop icons and renders its own interactive overlay with free-form icon grid and draggable fence cells.

Built with **Tauri v2** + **SolidJS** + **UnoCSS** + **Bun**.

<img width="2736" height="1730" alt="Screenshot" src="https://github.com/user-attachments/assets/473dadaf-a3dc-44d0-a4d2-2adca892809b" />

---

## Features

### Desktop Icon Management

- Hides Windows native `SysListView32` on startup, replaces it with a custom grid
- **Free-floating icons**: desktop files arranged in a vertical grid (top-to-bottom, like Windows)
- **Fence cells**: draggable, resizable, collapsible containers to organize icons into groups
- Drag icons **between cells** or **between cell and desktop area**
- `Shift+F10` or `ContextMenu` key to open the right-click menu when click-through is active
- Win+D immunity (Show Desktop doesn't hide the overlay)

### Fence Cells

- Create, delete, drag, resize, fold/unfold fence cells
- Right-click context menu on each cell: add icons, new cell, delete, exit
- Collapse/expand toggle in the title bar
- Custom background color and opacity

### One-Click Organize

- **Auto-Organize**: sorts all free icons into categorized cells — **Folders**, **Applications** (`.exe`, `.lnk`, `.bat`, `.cmd`, `.msc`), and **Files**
- **Reset Config**: deletes config file so next launch re-scans the desktop

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | [Tauri v2](https://v2.tauri.app/) |
| Frontend | [SolidJS](https://www.solidjs.com/) |
| Styling | [UnoCSS](https://unocss.dev/) (Tailwind preset) |
| Icons | [solid-icons](https://github.com/xl0/solid-icons) (Feather Icons) |
| Backend | Rust (raw Win32 FFI, no `windows` crate) |
| Config | TOML via `serde` + `toml` |
| TS Bindings | [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) |
| Build | [Bun](https://bun.sh/) for frontend, Cargo for Rust |

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh/) | ≥ 1.1 | JavaScript runtime & package manager |
| [Rust](https://www.rust-lang.org/) | ≥ 1.81 | Rust toolchain |
| [Tauri CLI](https://v2.tauri.app/start/cli/) | 2.x | `cargo install tauri-cli --version ^2` |

---

## Getting Started

```bash
# 1. Install JS dependencies
bun install

# 2. Run in development mode
bun run tauri dev
```

The app will open a full-screen transparent overlay that covers your desktop wallpaper. Native desktop icons are hidden automatically.

---

## Project Structure

```
DeskChan/
├── src/                          # Frontend (SolidJS + TypeScript)
│   ├── App.tsx                   # Root component (providers)
│   ├── main.tsx                  # Entry point
│   ├── components/
│   │   ├── Desktop.tsx           # Main surface: free icons, cells, drag, menus
│   │   └── ui/
│   │       ├── CellBox.tsx       # Draggable/resizable/collapsible fence cell
│   │       ├── ContextMenu.tsx   # Right-click context menu (Portal)
│   │       ├── DesktopIcon.tsx   # Single file shortcut icon component
│   │       └── SettingsDialog.tsx# Settings modal (theme, language, titles)
│   ├── i18n/                     # Translation files
│   │   ├── index.tsx             # i18n provider & hook
│   │   ├── zh-CN.ts              # Chinese translations
│   │   └── en-US.ts              # English translations
│   ├── lib/
│   │   ├── utils.ts              # `cn()` class merging
│   │   └── theme.tsx             # Theme provider (light/dark/auto)
│   ├── styles/
│   │   └── global.css            # Scrollbars, animations, theme transitions
│   └── vite-env.d.ts             # TypeScript type declarations
│
├── src-tauri/                    # Backend (Rust)
│   ├── src/
│   │   ├── main.rs               # Windows entry point
│   │   ├── lib.rs                # Tauri app setup, plugin registration, first-launch scan
│   │   ├── window_manager.rs     # Win32 window management: AppBar, WndProc, SysListView32, icon extraction
│   │   ├── bindings.rs           # All Tauri commands (thin proxy layer)
│   │   └── config.rs             # Data models (DesktopIcon, Cell, DeskConfig), TOML persistence
│   ├── bindings/                 # Generated TS type bindings (ts-rs)
│   ├── tauri.conf.json           # Tauri configuration
│   └── Cargo.toml                # Rust dependencies
│
├── package.json
├── uno.config.ts
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## Architecture

### How It Works

1. **Window**: A borderless, transparent, skip-taskbar window covers the work area (excluding taskbar)
2. **Desktop hiding**: On startup, Rust finds the `SysListView32` control (the native desktop icon renderer) and calls `ShowWindow(SW_HIDE)` — icons disappear
3. **Overlay rendering**: SolidJS renders free-floating icons in a grid and fence cells on top
4. **Icon extraction**: System file icons are fetched via `SHGetFileInfoW` → `CreateDIBSection` → `DrawIconEx` → PNG base64 → inline `<img>`
5. **Drag & drop**: Uses **Pointer Events** (not HTML5 Drag API, which conflicts with window styles in WebView2)
6. **Win+D**: Three-layer defense — AppBar registration + WndProc interception + Z-order counter-attack

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Files never leave the desktop** | Paths are stored in config; the app is a visual overlay only |
| **No file movement** | Unlike naive implementations, DeskChan does NOT move files between directories — it only manages their visual representation |
| **Pointer Events over HTML5 Drag** | HTML5 drag-and-drop breaks with `WS_EX_TOOLWINDOW` / `WS_EX_NOACTIVATE` in WebView2 |
| **Raw Win32 FFI** | No `windows` crate dependency — avoids version conflicts with Tauri's internal `windows-core` |
| **TOML config** | Human-readable, easy to debug and edit manually |

---

## How to build

```bash
# Development
bun run tauri dev          # Start dev server with hot-reload

# Build
bun run tauri build        # Production build

# TypeScript checks
bun run check              # tsc --noEmit

# Linting
bun run lint               # ESLint

# Rust checks
cd src-tauri && cargo check

# Regenerate TypeScript bindings from Rust structs
cd src-tauri && cargo test export_bindings
```

---

## Configuration

Config file location: `%APPDATA%\DeskChan\deskchan.toml`

```toml
version = 3
show_titles = true
theme = "auto"

[[cells]]
id = "uuid"
title = "Applications"
layout = "Grid"
opacity = 0.85

[[cells.rect]]
x = 50.0
y = 50.0
width = 320.0
height = 280.0

[[cells.icons]]
id = "uuid"
name = "My App"
path = "C:\\Users\\...\\Desktop\\app.exe"
icon_path = null

[[free_icons]]
id = "uuid"
name = "readme"
path = "C:\\Users\\...\\Desktop\\readme.txt"
icon_path = null
```

Use **Reset Config** in the context menu or delete the file manually to force a fresh start.

---

## License

GPL
