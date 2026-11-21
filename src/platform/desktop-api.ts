/** Desktop IPC contract. File and layout DTOs come from the Rust bindings. */
import { invoke } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { FileMutation } from '@bindings/FileMutation';
import type { FileUndoRecord } from '@bindings/FileUndoRecord';
import type { RenamedIconMutation } from '@bindings/RenamedIconMutation';
import type { StartupMode } from '@bindings/StartupMode';
import type { BackdropSurface } from '@bindings/BackdropSurface';

type Command<Result, Args extends InvokeArgs | undefined = undefined> = {
    result: Result;
    args: Args;
};

interface Commands {
    sync_backdrops: Command<number[], { surfaces: BackdropSurface[]; dark: boolean }>;
    get_config: Command<DeskConfig>;
    save_config: Command<void, { cfg: DeskConfig; rev: number }>;
    import_config: Command<DeskConfig | null, { rev: number }>;
    export_config: Command<boolean, { cfg: DeskConfig }>;
    reset_config: Command<DeskConfig, { rev: number }>;
    scan_desktop: Command<DesktopScan>;
    set_dragging: Command<void, { dragging: boolean }>;
    is_desktop_drop_point: Command<boolean, { x: number; y: number }>;
    start_native_file_drag: Command<number | null, { paths: string[] }>;
    move_to_desktop_with_undo: Command<FileMutation, { path: string }>;
    paste_from_clipboard_with_undo: Command<FileMutation, { mode: 'auto' | 'copy' | 'move' }>;
    file_action: Command<void, { paths: string[]; action: 'open_with' | 'cut' | 'copy' | 'properties' }>;
    open_file: Command<void, { path: string }>;
    get_file_icon: Command<string, { path: string; sizePx: number }>;
    rename_desktop_icon_with_undo: Command<
        RenamedIconMutation,
        { path: string; name: string; preserveExtension: boolean }
    >;
    delete_with_undo: Command<FileMutation, { paths: string[] }>;
    delete_permanently_with_undo: Command<FileMutation, { paths: string[] }>;
    undo_file_operation: Command<void, { record: FileUndoRecord }>;
    redo_file_operation: Command<void, { record: FileUndoRecord }>;
    discard_undo_backups: Command<void, { backups: string[] }>;
    show_icon_menu: Command<number | null, { paths: string[]; extraItems: string[] }>;
    show_desktop_menu: Command<number | null, { extraItems?: string[] }>;
    toggle_show_desktop: Command<void>;
    open_settings: Command<void, { section: 'personalization' | 'display' }>;
    quit_app: Command<void>;
    get_wallpaper_color: Command<string>;
    get_startup_mode: Command<StartupMode>;
    set_startup_mode: Command<void, { mode: StartupMode }>;
    check_for_updates: Command<string | null>;
    install_update: Command<void, { version: string }>;
}

export function desktopCommand<K extends keyof Commands>(
    command: K,
    ...parameters: Commands[K]['args'] extends undefined ? [] : [args: Commands[K]['args']]
): Promise<Commands[K]['result']> {
    return invoke(command, parameters[0]);
}
