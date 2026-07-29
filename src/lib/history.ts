/** Small, bounded undo/redo history for DeskChan-owned operations. */
export const HISTORY_LIMIT = 5;

export interface HistoryState<T> {
    undo: T[];
    redo: T[];
}

export function pushHistory<T>(state: HistoryState<T>, entry: T): HistoryState<T> {
    return {
        undo: [...state.undo, entry].slice(-HISTORY_LIMIT),
        redo: [],
    };
}

export function popUndo<T>(state: HistoryState<T>): { entry: T | null; state: HistoryState<T> } {
    const entry = state.undo.at(-1) ?? null;
    if (!entry) return { entry: null, state };
    return {
        entry,
        state: { undo: state.undo.slice(0, -1), redo: [...state.redo, entry].slice(-HISTORY_LIMIT) },
    };
}

export function popRedo<T>(state: HistoryState<T>): { entry: T | null; state: HistoryState<T> } {
    const entry = state.redo.at(-1) ?? null;
    if (!entry) return { entry: null, state };
    return {
        entry,
        state: { undo: [...state.undo, entry].slice(-HISTORY_LIMIT), redo: state.redo.slice(0, -1) },
    };
}
