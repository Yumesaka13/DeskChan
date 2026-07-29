# PR: Improve Windows Desktop Integration and Interaction Workflows

## Summary

This PR evolves DeskChan from a visual desktop overlay into a fuller Windows desktop workspace. It adds support for relocated Desktop folders, Explorer-compatible transfer and clipboard operations, shared multi-selection, per-cell arrangement, and monitor-aware menus. It also aligns desktop discovery with Explorer visibility, improves native shell integration, and introduces path authorization around privileged file operations.

## Comparison Base

The upstream `FengBujue0104/DeskChan` `main` tip was rechecked at `19ac6da3bd6b5956dc46e8c25b433196937acd7b`. The local `HEAD` is `e603d8c0b5bcb740d6b079e33a4d54b7da6f5d66`, an ancestor of that upstream commit rather than the same revision. This document therefore describes the intended feature delta while separately calling out upstream files that appear deleted only because the local checkout predates `19ac6da`. The implementation spans the SolidJS desktop surface, Tauri/Rust commands, Windows shell and window code, persistent configuration, translations, tests, and generated schemas/bindings.

## Desktop Discovery and File Workflows

- Resolve the actual Windows Desktop known folder with `SHGetKnownFolderPath`. A Desktop redirected from `%USERPROFILE%\\Desktop` to a location such as `D:\\Desktop` is therefore both scanned and used as the destination for new items.
- Continue to render the merged user and Public Desktop view, while all writes target the configured user Desktop.
- Match Explorer visibility when scanning filesystem-backed desktop entries. Hidden or system entries are excluded by inspecting the entry itself with `symlink_metadata`, so anti-ransomware canary links such as Huorong's ` RESOURCE890` (with a leading space) and `ZTOOL99` bait directories are never rendered or persisted. The canaries are not modified or deleted.
- Reconcile the first native scan before rendering saved icons. Stale entries are removed deterministically on startup instead of relying on repeated delay-based "stable" scans or a later manual refresh.
- Treat Explorer drag-and-drop as a move into the desktop folder. Existing names receive an Explorer-like ` (n)` suffix. Cross-volume moves safely fall back to copy followed by source removal.
- Add clipboard paste through the desktop context menu and `Ctrl+V`. Explicit Copy and Move choices are provided; the shortcut honors Explorer's `Preferred DropEffect` marker.
- Add `Ctrl+C`, Cut, Copy, Delete-to-Recycle-Bin, and Explorer-compatible `CF_HDROP` clipboard output, allowing selected items to be pasted into other compatible programs.

## Selection, Arrangement, and Organization

- Implement one shared selection model for free icons and cell contents. Plain click selects one item, Ctrl-click toggles items, empty-area drag makes a marquee selection, and blank click, refresh, or Escape clears selection.
- Support group drag and group file actions for selected free icons. Multi-file native menu operations are limited to items from the same parent folder, matching shell expectations.
- Add automatic arrangement and sorting by name, file type, or modification date in ascending or descending order.
- Add equivalent arrangement menus to cells. Cells can use the existing grid or a compact list presentation; the list intentionally hides large icons so each entry occupies a useful row.
- Persist each cell's sort field and direction independently. Add a per-file organization exclusion so selected free desktop files remain where they are during one-click organization.

## Menus and Native Shell Integration

- Provide a styled file menu with Open, Open with, organization opt-out, Cut, Copy, Delete, Properties, and More system options. Settings can switch back to the native menu.
- Use the Windows `OpenAs_RunDLL` entry point for Open with even when a default association exists, and invoke the canonical shell `properties` verb for files and folders.
- Extend native file menus for multi-selection and dynamic entries such as Open With and Send To. The desktop More System Options command uses a DeskChan-owned `IContextMenu` from the Shell desktop folder and runs it through `TrackPopupMenuEx` on the Tauri main thread.
- Keep Explorer's native `SysListView32` hidden for the complete menu operation, eliminating native-icon flashes and cross-process foreground races. This stable menu can omit Explorer view-specific commands that are unavailable from the desktop-folder context object; Personalize, Display settings, arrangement, sorting, and refresh remain available in DeskChan's primary desktop menu.
- Rework styled submenu state to preserve second- and third-level panels while the pointer crosses between adjacent menus.
- Place every menu level within the selected monitor, reverse submenu direction near horizontal edges, clamp vertical placement, and use each monitor's `workArea` so menus avoid taskbars and docks.

## Multi-Monitor Presentation and Settings

- Cover the virtual desktop while keeping menus and Settings anchored to the monitor that received the desktop right-click.
- Make Settings draggable and initially center it on the triggering monitor rather than across a display boundary.
- Add preferences for styled/native file menus and file-extension visibility.
- Apply the configurable contrast overlay only inside cell bounds. The desktop interaction root stays transparent, preserving wallpaper appearance outside cells.
- Allow long free-icon names to expand without being obscured by lower icons.

## Configuration, Security, and Native Layer

- Extend `DeskConfig` with organization exclusions, menu preference, extension visibility, cell layout, independent cell sorting, and cell-only overlay opacity. Defaults and validation preserve existing TOML configurations.
- Add `path_security.rs` to authorize scanned, dropped, and pasted local paths; reject unsupported/non-local paths; validate imported/exported TOML paths; and constrain native commands to approved paths.
- Regenerate Tauri TypeScript bindings and capability schemas for the changed commands and models.
- Remove renderer-side filesystem and shell plugin permissions in favor of the command-backed native layer. The default capability is reduced to core and narrowly scoped dialog permissions.
- Disable the global Tauri API and replace the unrestricted CSP with a restrictive policy for local assets and the IPC bridge.
- Update Windows window-management and shell-menu code for native menu message forwarding, properties invocation, work-area geometry, and stable menu ownership. Two attempted complete-menu bridges are intentionally excluded: cross-process `IShellView::GetItemObject` returned `REGDB_E_IIDNOTREG (0x80040155)`, while forwarding `WM_CONTEXTMENU` to the hidden Explorer view either lost foreground ownership or required revealing native icons.

## Repository and Documentation Notes

- Relative to upstream `19ac6da`, the diff removes the default bug-report and feature-request templates because the local `e603d8c` checkout predates the upstream issue-template commit. This is unrelated to the desktop work; restore those files or rebase onto upstream before submitting the PR.
- `README.md` receives formatting-only changes in this delta. Its existing statement that DeskChan performs "No file movement" no longer fully describes drag-and-drop and clipboard behavior, which can move external items into the configured Desktop. Update that statement in the PR or split the README correction into a follow-up.
- The `custom-protocol` Cargo feature supports producing the portable release executable by embedding `frontendDist`; unused frontend Tauri filesystem and shell dependencies are removed.

## Reviewer Checklist

1. Redirect the Windows Desktop known folder, restart the application, then drop, paste, and organize files to verify that every write reaches the redirected folder.
2. Create or identify a hidden/system entry on the user or Public Desktop and confirm it never flashes at startup or appears after refresh. Do not alter security-product canary directories during this test.
3. Exercise `Ctrl+C`, `Ctrl+V`, Delete, Ctrl-click, marquee selection, group drag, and multi-file context-menu actions with free icons and cell items.
4. Open desktop and file menus on every display, near display boundaries, and beside the taskbar. Confirm nested menus remain visible and inside the active monitor work area; repeatedly open More System Options, confirm no native desktop icons flash, and verify the menu remains open until explicitly dismissed.
5. Change each cell's layout, sort field, and sort direction independently; restart and confirm the configuration persists.
6. Toggle styled/native menus, extension visibility, and overlay opacity. Verify wallpaper outside cells is never tinted.
7. Confirm import/export, file actions, and native menu commands reject paths that were not discovered, dropped, or pasted through the application.

## Validation Performed

- `bun test` - 53 frontend tests passed
- `bun run tsc --noEmit` - TypeScript check passed
- `cargo test --lib` - 14 Rust tests passed
- `bun run build` - production frontend build passed
- `cargo build --release --features custom-protocol` from `src-tauri` - release executable built successfully
- `git diff --check` - no whitespace errors

The desktop-folder system menu still requires interactive verification because a native popup loop cannot be exercised reliably from a headless/unit-test process. Its reduced command set is an explicit stability tradeoff, not a claim of parity with Explorer's live background menu. Before merge, attach screenshots or a short recording demonstrating repeated native-menu use without icon flashes, multi-monitor menu placement, clipboard transfer, selection behavior, startup filtering, and the cell-only overlay.
