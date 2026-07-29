import { expect, test } from 'vitest';
import { HISTORY_LIMIT, popRedo, popUndo, pushHistory } from './history';

test('history keeps five entries and clears redo after a new operation', () => {
    let state = { undo: [] as number[], redo: [] as number[] };
    for (let i = 0; i < HISTORY_LIMIT + 2; i++) state = pushHistory(state, i);
    expect(state.undo).toEqual([2, 3, 4, 5, 6]);
    const undone = popUndo(state);
    expect(undone.entry).toBe(6);
    expect(undone.state.redo).toEqual([6]);
    expect(pushHistory(undone.state, 7)).toEqual({ undo: [2, 3, 4, 5, 7], redo: [] });
});

test('undo and redo are LIFO', () => {
    const state = { undo: ['one', 'two'], redo: [] as string[] };
    const undo = popUndo(state);
    const redo = popRedo(undo.state);
    expect(undo.entry).toBe('two');
    expect(redo.entry).toBe('two');
    expect(redo.state).toEqual(state);
});
