# DeskChan

DeskChan is a Windows desktop organizer built with Tauri, Rust, SolidJS, and UnoCSS. It displays your user and public desktop files over the wallpaper and lets you group them into fences.

## Features

- Desktop icons start in the positions reported by Windows Explorer. DeskChan saves its own layout after launch.
- Fences can move, resize, snap to each other, roll up, and display grid or list views. Each fence can contain named tabs.
- Icons support marquee and multi-selection, drag-and-drop between fences, and native file drag-and-drop with other applications.
- Desktop and file context menus offer sorting, organizing, clipboard actions, renaming, deletion, and access to the Windows shell menu.
- Layout and file operations support undo, redo, and a session history. Layouts can be imported, exported, and reset.
- Settings include Chinese and English, light and dark themes, wallpaper tint, filename display, startup modes, and GitHub Release updates.

## Development

On Windows, install Bun and Rust plus the Visual Studio C++ Build Tools required by Tauri.

```powershell
bun install
bun run tauri dev
```

`bun run tauri build` produces both NSIS and MSI installers in `src-tauri/target/release/bundle`. The debug frontend can also run on its own with `bun run dev` when testing against a mock IPC environment.

## Architecture

| Area | Location | Responsibility |
| --- | --- | --- |
| Desktop | `src/features/desktop` | Session, layout, selection, gestures, file workflows, menus, and shortcuts |
| Fences | `src/features/cells` | Fence commands and pointer-driven geometry |
| Settings | `src/features/settings` | System, appearance, and layout pages |
| UI | `src/components/ui` and `src/styles` | Fluent components, semantic color tokens, responsive panels, and keyboard focus |
| IPC | `src/platform/desktop-api.ts` and `src-tauri/src/bindings.rs` | Typed frontend calls and Rust command entry points |
| Layout store | `src-tauri/src/layout_store.rs` and `config.rs` | Layout revisions, validation, migration, recovery, and TOML persistence |
| Windows desktop | `src-tauri/src/app.rs`, `explorer_layout.rs`, and `window_manager.rs` | Session lifecycle, Explorer placement, and overlay Z-order |
| Files and shell | `src-tauri/src/desktop`, `native_drag.rs`, `shell_menu.rs`, and `shell_icons.rs` | Desktop enumeration, file actions, notifications, and Windows shell interop |

The frontend commits a new layout after a gesture ends and debounces configuration writes. Rust serializes those writes and validates the layout before saving it. First-run initialization queries Explorer before hiding the native view, matches items by path, and converts the positions to the overlay's coordinate space. When a shell position is unavailable, DeskChan assigns an open grid slot.

UI spacing, elevation, typography, focus states, and menu motion follow [Fluent 2](https://fluent2.microsoft.design/). The Windows compositor supplies Acrylic for fences, menus, and Settings, and Mica for history. The material windows track the WebView surfaces and stay in the desktop overlay's Z-order group. If Windows disables transparency or the material cannot be applied, the surfaces use solid theme colors. Fluent menus follow the Windows motion preference and can be switched to the system context menus in Settings.

## Checks

```powershell
bun run check
bun run lint
bun run test --run
cd src-tauri
cargo test export_bindings
cargo test
```

Run the live Explorer integration check from an interactive Windows desktop with at least one file.

```powershell
cargo test reads_live_explorer_positions_for_desktop_files -- --ignored --nocapture
```

## Configuration

The layout is stored in `%APPDATA%\com.deskchan.app\deskchan.toml`.

```toml
version = 3
theme = "auto"

[[cells]]
id = "applications"
title = "Applications"
layout = "Grid"
opacity = 0.85

[cells.rect]
x = 50.0
y = 50.0
width = 320.0
height = 280.0

[[cells.icons]]
id = "app-shortcut"
name = "My App"
path = "C:\\Users\\...\\Desktop\\app.exe"

[[free_icons]]
id = "readme"
name = "readme"
path = "C:\\Users\\...\\Desktop\\readme.txt"
pos_x = 96.0
pos_y = 42.0
```

Use **Settings → Data → Reset Config** to rebuild the layout from the current Explorer desktop.

---

## License

GPL
