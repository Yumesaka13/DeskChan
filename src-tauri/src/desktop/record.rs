//! Native file mutation types shared with the desktop session.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../bindings/")]
pub enum FileOperation {
    Copy,
    Move,
    Rename,
    Delete,
    DeletePermanent,
}

/// A filesystem mutation that DeskChan can reverse during this session.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct FileUndoRecord {
    pub kind: FileOperation,
    pub sources: Vec<String>,
    pub destinations: Vec<String>,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct FileMutation {
    pub paths: Vec<String>,
    pub record: FileUndoRecord,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct RenamedIconMutation {
    pub path: String,
    pub name: String,
    pub record: FileUndoRecord,
}
