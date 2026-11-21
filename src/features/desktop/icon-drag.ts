import { createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import toast from 'solid-toast';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { removeIcon, reorderIcons, withActiveIcons } from '~/lib/cell';
import { effectiveCellRect, nearestFreeSlot } from '~/lib/grid';
import type { DesktopSession } from './session';
import type { DesktopLayout } from './layout';
import type { DesktopSelection } from './selection';
import { allConfigIcons, viewportSize, type Translate } from './types';

interface DragState {
    pointerId: number;
    iconId: string;
    source: 'cell' | 'free';
    cellId: string;
    icon: DIcon;
    x: number;
    y: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    /** Every icon moving together - the multi-selection for free-icon
     *  drags, or just the dragged icon itself. */
    group: DIcon[];
    /** Only becomes a real drag after a small movement threshold -
     *  otherwise plain clicks/double-clicks would trigger drop logic. */
    moved: boolean;
}

export function createIconDrag(
    session: DesktopSession,
    layout: DesktopLayout,
    selection: DesktopSelection,
    t: Translate,
) {
    const { config, commitConfig, reconcileDesktop } = session;
    const { cellAtPoint, updateCell, resolveDropPos } = layout;
    const [dragState, setDragState] = createSignal<DragState | null>(null);
    const [nativeDragActive, setNativeDragActive] = createSignal(false);
    const clearDrag = () => {
        setDragState(null);
        desktopCommand('set_dragging', { dragging: false }).catch(() => {});
    };
    onMount(() => {
        let probing = false;
        const isDesktopPoint = (e: PointerEvent) =>
            desktopCommand('is_desktop_drop_point', {
                x: Math.round(e.clientX * window.devicePixelRatio),
                y: Math.round(e.clientY * window.devicePixelRatio),
            });
        const dragPaths = (ds: DragState): string[] => {
            const groupIds = new Set((ds.group.length > 0 ? ds.group : [ds.icon]).map((g) => g.id));
            const cfg = config();
            const live = cfg
                ? allConfigIcons(cfg).filter((icon) => groupIds.has(icon.id))
                : ds.group.length > 0
                  ? ds.group
                  : [ds.icon];
            return live.map((icon) => icon.path);
        };

        const updatePreview = (ds: DragState, e: PointerEvent): DragState => ({
            ...ds,
            x: e.clientX,
            y: e.clientY,
            moved: ds.moved || Math.abs(e.clientX - ds.startX) > 4 || Math.abs(e.clientY - ds.startY) > 4,
        });

        const onMove = (e: PointerEvent) => {
            const ds = dragState();
            if (!ds || e.pointerId !== ds.pointerId) return;
            if (!(e.buttons & 1)) {
                clearDrag();
                return;
            }
            const next = updatePreview(ds, e);
            setDragState(next);
            if (!next.moved || probing || nativeDragActive()) return;
            probing = true;
            void isDesktopPoint(e)
                .then((inside) => {
                    const current = untrack(dragState);
                    // The IPC result may arrive after a drop or after the
                    // pointer returned to the desktop. Rust rechecks on handoff.
                    if (!inside && current?.group === ds.group) handoffNativeDrag(current);
                })
                .catch(() => {})
                .finally(() => {
                    probing = false;
                });
        };

        const onEnd = async (e: PointerEvent) => {
            const active = dragState();
            if (!active || active.pointerId !== e.pointerId || e.button !== 0) return;
            const ds = updatePreview(active, e);
            clearDrag();
            if (!ds.moved) return; // plain click, not a drag
            // Re-resolve members from the CURRENT config - a watcher
            // reconcile mid-drag may have replaced or removed icon objects,
            // and re-adding stale snapshots could duplicate files.
            const groupIds = new Set((ds.group.length > 0 ? ds.group : [ds.icon]).map((g) => g.id));
            // The trailing click after a drag would collapse a fresh
            // multi-selection - but only if it lands on a dragged icon.
            // Setting the flag unconditionally made it linger after drags
            // that end on empty desktop, silently eating the NEXT click.
            const droppedOnId =
                document
                    .elementFromPoint(ds.x, ds.y)
                    ?.closest('[data-icon-id]')
                    ?.getAttribute('data-icon-id') ?? null;
            if (droppedOnId !== null && groupIds.has(droppedOnId)) {
                selection.setClickSuppressed(true);
                // The trailing click that normally consumes this flag may
                // never fire (e.g. release outside the window) - don't let
                // it eat the user's next click forever.
                setTimeout(() => {
                    selection.setClickSuppressed(false);
                }, 500);
            }
            // A fast release over another window can beat the native handoff.
            // Window hit testing still prevents applying a hidden desktop move.
            if (!(await isDesktopPoint(e).catch(() => false))) return;
            const targetCell = cellAtPoint(ds.x, ds.y);

            if (targetCell && targetCell !== ds.cellId) {
                // The whole selection drops into the target's active tab
                commitConfig(t('history.move_into_cell'), (p) => {
                    if (!p) return p;
                    const live =
                        ds.source === 'free' ? p.free_icons.filter((i) => groupIds.has(i.id)) : [ds.icon];
                    return {
                        ...p,
                        free_icons:
                            ds.source === 'free'
                                ? p.free_icons.filter((i) => !groupIds.has(i.id))
                                : p.free_icons,
                        cells: p.cells.map((c) => {
                            if (c.id === ds.cellId && ds.source === 'cell') return removeIcon(c, ds.iconId);
                            if (c.id === targetCell)
                                return withActiveIcons(c, (icons) => [...icons, ...live]);
                            return c;
                        }),
                    };
                });
            } else if (targetCell && targetCell === ds.cellId && ds.source === 'cell') {
                // In-cell reorder: the drop position picks the new slot
                // (before/after the icon under the cursor, or to the end)
                const el = document.elementFromPoint(ds.x, ds.y)?.closest('[data-icon-id]');
                const targetId = el?.getAttribute('data-icon-id') ?? null;
                const before = el
                    ? ds.x < el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2
                    : false;
                updateCell(ds.cellId, (c) =>
                    withActiveIcons(c, (icons) => reorderIcons(icons, ds.iconId, targetId, before)),
                );
            } else if (!targetCell) {
                if (ds.source === 'cell') {
                    const pos = resolveDropPos(ds.x - ds.offsetX, ds.y - ds.offsetY, ds.iconId);
                    commitConfig(t('history.move_into_cell'), (p) =>
                        p
                            ? {
                                  ...p,
                                  cells: p.cells.map((c) =>
                                      c.id === ds.cellId ? removeIcon(c, ds.iconId) : c,
                                  ),
                                  free_icons: [...p.free_icons, { ...ds.icon, pos_x: pos.x, pos_y: pos.y }],
                              }
                            : p,
                    );
                } else {
                    // Reposition: shift every group member by the drag delta,
                    // then snap sequentially (occupied accumulates) so members
                    // never stack onto the same slot. Positions come from the
                    // live config, not the drag-start snapshot.
                    const dx = ds.x - ds.startX;
                    const dy = ds.y - ds.startY;
                    commitConfig(t('history.reposition'), (p) => {
                        if (!p) return p;
                        const cellRects = p.cells.map(effectiveCellRect);
                        const occupied = p.free_icons
                            .filter((i) => !groupIds.has(i.id) && i.pos_x >= 0)
                            .map((i) => ({ x: i.pos_x, y: i.pos_y }));
                        const movedPos = new Map<string, { x: number; y: number }>();
                        for (const g of p.free_icons.filter((i) => groupIds.has(i.id))) {
                            const nx = Math.max(0, g.pos_x + dx);
                            const ny = Math.max(0, g.pos_y + dy);
                            const pos = p.snap_to_grid
                                ? nearestFreeSlot(nx, ny, occupied, cellRects, viewportSize())
                                : { x: nx, y: ny };
                            occupied.push(pos);
                            movedPos.set(g.id, pos);
                        }
                        return {
                            ...p,
                            free_icons: p.free_icons.map((i) => {
                                const m = movedPos.get(i.id);
                                return m ? { ...i, pos_x: m.x, pos_y: m.y } : i;
                            }),
                        };
                    });
                }
            }
        };

        const handoffNativeDrag = (ds: DragState) => {
            if (nativeDragActive()) return;
            // The native drag session owns the pointer from here - no
            // trailing click follows on our icons, and a stale flag would
            // swallow the user's next click.
            selection.setClickSuppressed(false);
            const paths = dragPaths(ds);
            if (paths.length === 0) {
                clearDrag();
                return;
            }
            setNativeDragActive(true);
            void desktopCommand('start_native_file_drag', { paths })
                .then((effect) => {
                    if (effect === null) return;
                    setDragState(null);
                    // A native MOVE removes the source from its original location.
                    // Tell reconciliation explicitly so imported, non-desktop icons
                    // do not remain as stale config entries.
                    if ((effect & 2) !== 0) void reconcileDesktop(paths);
                })
                .catch(() => {
                    clearDrag();
                    toast.error(t('toast.file_action_failed'));
                })
                .finally(() => {
                    setNativeDragActive(false);
                    if (!untrack(dragState))
                        desktopCommand('set_dragging', { dragging: false }).catch(() => {});
                });
        };

        const onLeave = (e: PointerEvent) => {
            const ds = dragState();
            if (!ds || ds.pointerId !== e.pointerId) return;
            if (!(e.buttons & 1)) {
                clearDrag();
                return;
            }
            if (updatePreview(ds, e).moved) handoffNativeDrag(ds);
        };
        const onCancel = (e: PointerEvent) => {
            if (!nativeDragActive() && dragState()?.pointerId === e.pointerId) clearDrag();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointerleave', onLeave);
        window.addEventListener('pointercancel', onCancel);
        onCleanup(() => {
            clearDrag();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointerleave', onLeave);
            window.removeEventListener('pointercancel', onCancel);
        });
    });

    const start = (icon: DIcon, cellId: string | null, event: PointerEvent) => {
        if (nativeDragActive()) return;
        selection.setClickSuppressed(false);
        if (!cellId && !(event.ctrlKey || event.metaKey) && !selection.selectedIds().has(icon.id)) {
            selection.setSelectedIds(new Set([icon.id]));
        }
        const group = cellId
            ? [icon]
            : (config()?.free_icons ?? []).filter(
                  (candidate) => selection.selectedIds().has(candidate.id) || candidate.id === icon.id,
              );
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        setDragState({
            pointerId: event.pointerId,
            iconId: icon.id,
            source: cellId ? 'cell' : 'free',
            cellId: cellId ?? '',
            icon,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            group,
            moved: false,
        });
        void desktopCommand('set_dragging', { dragging: true }).catch(() => {});
    };

    return { preview: () => (!nativeDragActive() ? dragState() : null), start, cancel: clearDrag };
}
