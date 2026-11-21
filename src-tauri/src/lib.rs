//! DeskChan Tauri application entry point.

mod app;
mod bindings;
mod config;
mod desktop;
mod explorer_layout;
mod layout_store;
mod materials;
mod native_drag;
mod path_security;
mod shell_icons;
mod shell_menu;
mod startup;
mod update;
mod wallpaper;
#[cfg(target_os = "windows")]
mod win32;
mod window_manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(app::setup)
        .invoke_handler(tauri::generate_handler![
            bindings::get_config,
            bindings::get_startup_mode,
            bindings::set_startup_mode,
            bindings::check_for_updates,
            bindings::install_update,
            bindings::save_config,
            bindings::open_file,
            bindings::start_native_file_drag,
            bindings::is_desktop_drop_point,
            bindings::file_action,
            bindings::rename_desktop_icon_with_undo,
            bindings::set_dragging,
            bindings::get_file_icon,
            bindings::quit_app,
            bindings::reset_config,
            bindings::scan_desktop,
            bindings::move_to_desktop,
            bindings::move_to_desktop_with_undo,
            bindings::paste_from_clipboard,
            bindings::paste_from_clipboard_with_undo,
            bindings::delete_with_undo,
            bindings::delete_permanently_with_undo,
            bindings::undo_file_operation,
            bindings::redo_file_operation,
            bindings::discard_undo_backups,
            bindings::export_config,
            bindings::import_config,
            bindings::show_icon_menu,
            bindings::show_desktop_menu,
            bindings::toggle_show_desktop,
            bindings::open_settings,
            bindings::get_wallpaper_color,
            bindings::sync_backdrops,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(app::on_event);
}
