/**
 * Cell/sub-box helpers — pure logic for the tabbed sub-cell system.
 * A cell's icon containers are its own `icons` (the implicit first tab)
 * plus one per sub-cell; `active_sub` selects which container the UI shows
 * and which one receives added/dropped icons.
 */
import type { Cell } from '@bindings/Cell';
import type { DesktopIcon } from '@bindings/DesktopIcon';

/** The icon list of the active tab (cell's own icons when no sub is active). */
export function activeIcons(c: Cell): DesktopIcon[] {
    const sub = c.sub_cells.find((s) => s.id === c.active_sub);
    return sub ? sub.icons : c.icons;
}

/** Immutably transform the ACTIVE tab's icon list. */
export function withActiveIcons(c: Cell, fn: (icons: DesktopIcon[]) => DesktopIcon[]): Cell {
    const sub = c.sub_cells.find((s) => s.id === c.active_sub);
    if (!sub) return { ...c, icons: fn(c.icons) };
    return {
        ...c,
        sub_cells: c.sub_cells.map((s) => (s.id === sub.id ? { ...s, icons: fn(s.icons) } : s)),
    };
}

/** Remove an icon wherever it lives in the cell (own icons or any sub). */
export function removeIcon(c: Cell, iconId: string): Cell {
    return {
        ...c,
        icons: c.icons.filter((i) => i.id !== iconId),
        sub_cells: c.sub_cells.map((s) =>
            s.icons.some((i) => i.id === iconId)
                ? { ...s, icons: s.icons.filter((i) => i.id !== iconId) }
                : s,
        ),
    };
}

/** Total icons across the cell's own list and every sub-box. */
export function totalIconCount(c: Cell): number {
    return c.icons.length + c.sub_cells.reduce((n, s) => n + s.icons.length, 0);
}

/** Reorder within one icon list: move `dragId` before/after `targetId`
 *  (or to the end when targetId is null). Returns the SAME array when
 *  nothing changes, so callers can skip re-render/save. */
export function reorderIcons(
    icons: DesktopIcon[],
    dragId: string,
    targetId: string | null,
    before: boolean,
): DesktopIcon[] {
    const from = icons.findIndex((i) => i.id === dragId);
    if (from < 0 || dragId === targetId) return icons;
    const without = icons.filter((i) => i.id !== dragId);
    let at = targetId ? without.findIndex((i) => i.id === targetId) : without.length;
    if (at < 0) at = without.length;
    else if (!before && targetId) at += 1;
    const next = [...without.slice(0, at), icons[from]!, ...without.slice(at)];
    return next.every((icon, n) => icon === icons[n]) ? icons : next;
}

/** Delete a sub-box; its icons are preserved by moving them to the cell's
 *  own (first) tab, and the selection falls back there when needed. */
export function deleteSubCell(c: Cell, subId: string): Cell {
    const sub = c.sub_cells.find((s) => s.id === subId);
    if (!sub) return c;
    return {
        ...c,
        icons: [...c.icons, ...sub.icons],
        sub_cells: c.sub_cells.filter((s) => s.id !== subId),
        active_sub: c.active_sub === subId ? null : c.active_sub,
    };
}
