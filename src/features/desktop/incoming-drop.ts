import { onCleanup, onMount } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import { getCurrentWindow } from '@tauri-apps/api/window';
import toast from 'solid-toast';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import type { FileUndoRecord } from '@bindings/FileUndoRecord';
import { allIcons } from '~/lib/cell';
import type { DesktopSession } from './session';
import type { DesktopLayout } from './layout';
import type { Translate } from './types';

export function registerIncomingDrop(session: DesktopSession, layout: DesktopLayout, t: Translate) {
    const { commitConfig } = session;
    const { cellAtPoint, resolveDropPos, addIconToCell } = layout;
    const pendingExternalMoves = new Set<string>();
    const addFreeIconAt = (filePath: string, x: number, y: number, file?: FileUndoRecord) => {
        commitConfig(
            t(file ? 'history.file_move' : 'history.add_icon'),
            (p) => {
                if (!p) return p;
                // The folder watcher may have reconciled it in already - dedupe by
                // path across free icons AND every cell container (subs included)
                const low = filePath.toLowerCase();
                if (
                    p.free_icons.some((i) => i.path.toLowerCase() === low) ||
                    p.cells.some((c) => allIcons(c).some((i) => i.path.toLowerCase() === low))
                ) {
                    return p;
                }
                const icon: DIcon = {
                    id: crypto.randomUUID(),
                    name:
                        filePath
                            .split(/[\\/]/)
                            .pop()
                            ?.replace(/\.[^.]+$/, '') ?? t('default.icon_name'),
                    path: filePath,
                    icon_path: null,
                    pos_x: x,
                    pos_y: y,
                };
                return { ...p, free_icons: [...p.free_icons, icon] };
            },
            file,
        );
    };

    /** Move an Explorer drop to the configured desktop, then place its icon. */
    const dropExternalFile = (filePath: string, x: number, y: number) => {
        const key = filePath.toLowerCase();
        if (pendingExternalMoves.has(key)) return;
        pendingExternalMoves.add(key);
        const targetCell = cellAtPoint(x, y);
        const freePosition = targetCell ? null : resolveDropPos(x - 38, y - 48);
        desktopCommand('move_to_desktop_with_undo', { path: filePath })
            .then((mutation) => {
                const newPath = mutation.paths[0];
                if (targetCell) {
                    addIconToCell(targetCell, newPath, mutation.record);
                } else {
                    addFreeIconAt(newPath, freePosition!.x, freePosition!.y, mutation.record);
                }
            })
            .catch(() => {
                toast.error(t('toast.drop_failed'));
            })
            .finally(() => pendingExternalMoves.delete(key));
    };

    const handleDomDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const files = e.dataTransfer?.files;
        if (!files?.length) return;
        for (let i = 0; i < files.length; i++) {
            const file = files[i] as File & { path?: string };
            dropExternalFile(file.path ?? file.name, e.clientX, e.clientY);
        }
    };

    // -- Tauri native drag-and-drop event ---------------------------------
    onMount(() => {
        let unlisten: (() => void) | undefined;
        let disposed = false;

        void getCurrentWindow()
            .onDragDropEvent((ev) => {
                const p = ev.payload;
                if (p.type !== 'drop' || !p.paths?.length) return;

                const dpr = window.devicePixelRatio || 1;
                const cssX = (p.position?.x ?? 400) / dpr;
                const cssY = (p.position?.y ?? 300) / dpr;
                for (const filePath of p.paths) {
                    dropExternalFile(filePath, cssX, cssY);
                }
            })
            .then((stopListening) => {
                if (disposed) stopListening();
                else unlisten = stopListening;
            })
            .catch(() => {
                toast.error(t('toast.drop_failed'));
            });

        onCleanup(() => {
            disposed = true;
            unlisten?.();
        });
    });
    // Native drag listeners on window level - capture phase forces allow
    onMount(() => {
        const allow = (e: Event) => {
            e.preventDefault();
            const dt = (e as DragEvent).dataTransfer;
            if (dt) dt.dropEffect = 'move';
        };
        // capture:true ensures we intercept BEFORE any child (CellBox) ignores the event
        window.addEventListener('dragenter', allow, { capture: true });
        window.addEventListener('dragover', allow, { capture: true });
        window.addEventListener('drop', handleDomDrop, { capture: true });
        onCleanup(() => {
            window.removeEventListener('dragenter', allow, { capture: true });
            window.removeEventListener('dragover', allow, { capture: true });
            window.removeEventListener('drop', handleDomDrop, { capture: true });
        });
    });
}
