//! Desktop file catalog, mutations, and notifications.

mod catalog;
mod clipboard;
mod files;
mod record;
mod watcher;

pub use catalog::{desktop_dirs, first_run_config, list_entries};
#[cfg(target_os = "windows")]
pub use clipboard::copy_paths_to_clipboard;
pub use clipboard::{paste_from_clipboard, paste_from_clipboard_with_undo};
#[cfg(target_os = "windows")]
pub use files::recycle_paths;
pub use files::{
    delete_permanently_with_undo, delete_with_undo, move_to_desktop, move_to_desktop_with_undo,
    redo_file_operation, rename_with_undo, undo_file_operation,
};
pub use record::{FileMutation, FileOperation, FileUndoRecord, RenamedIconMutation};
pub use watcher::start_watcher;
