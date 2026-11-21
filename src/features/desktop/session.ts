import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import toast from 'solid-toast';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopScan } from '@bindings/DesktopScan';
import type { FileUndoRecord } from '@bindings/FileUndoRecord';
import { arrangeFreeIcons, deduplicateConfigIcons, reconcileConfig } from '~/lib/grid';
import { HISTORY_LIMIT, popRedo, popUndo, pushHistory, type HistoryState } from '~/lib/history';
import { viewportSize, type Translate } from './types';

export interface HistoryEntry {
    id: string;
    label: string;
    before: DeskConfig;
    after: DeskConfig;
    file?: FileUndoRecord;
}

export type DesktopSession = ReturnType<typeof createDesktopSession>;

export function createDesktopSession(t: Translate) {
    const [config, setConfig] = createSignal<DeskConfig | null>(null);
    const [history, setHistory] = createSignal<HistoryState<HistoryEntry>>({ undo: [], redo: [] });
    let applyingHistory = false;
    const cloneConfig = (value: DeskConfig) => structuredClone(value);

    /**
     * Push a history entry and notify the backend about backups made
     * unreachable: the bounded history just evicted the oldest undo entry,
     * and a new action clears the whole redo stack. Their file backups
     * would otherwise sit in AppData forever.
     */
    const pushHistoryEntry = (entry: HistoryEntry) => {
        const current = history();
        const orphaned: HistoryEntry[] = [];
        if (current.undo.length >= HISTORY_LIMIT) orphaned.push(current.undo[0]);
        orphaned.push(...current.redo);
        setHistory(pushHistory(current, entry));
        for (const old of orphaned) {
            if (old.file?.backups?.length) {
                desktopCommand('discard_undo_backups', { backups: old.file.backups }).catch(() => {});
            }
        }
    };

    const commitConfig = (
        label: string,
        change: (current: DeskConfig) => DeskConfig,
        file?: FileUndoRecord,
    ) => {
        const before = config();
        if (!before || applyingHistory) return;
        const after = change(before);
        if (after === before) return;
        setConfig(after);
        pushHistoryEntry({
            id: crypto.randomUUID(),
            label,
            before: cloneConfig(before),
            after: cloneConfig(after),
            file,
        });
    };
    /** Undo one entry. Returns false when it failed - the entry stays on the
     *  stack, so callers must not retry in a loop. */
    const applyHistory = async (direction: 'undo' | 'redo'): Promise<boolean> => {
        if (applyingHistory) return false;
        const { entry, state } = direction === 'undo' ? popUndo(history()) : popRedo(history());
        if (!entry) return true;
        applyingHistory = true;
        try {
            if (entry.file) {
                const command = direction === 'undo' ? 'undo_file_operation' : 'redo_file_operation';
                await desktopCommand(command, { record: entry.file });
            }
            setConfig(cloneConfig(direction === 'undo' ? entry.before : entry.after));
            setHistory(state);
            // Re-merge watcher changes that arrived while the native action ran.
            void reconcileDesktop();
            return true;
        } catch {
            toast.error(t('toast.file_action_failed'));
            return false;
        } finally {
            applyingHistory = false;
        }
    };
    const undoLatest = () => applyHistory('undo');
    const redoLatest = () => applyHistory('redo');
    const reconcileSnapshot = (
        cfg: DeskConfig,
        scan: DesktopScan,
        removedPaths: readonly string[] = [],
    ) => {
        const next = reconcileConfig(cfg, scan, viewportSize(), removedPaths);
        // Auto-arrange compacts the layout on every desktop change.
        return cfg.auto_arrange && next !== cfg ? arrangeFreeIcons(next, viewportSize()) : next;
    };

    const reconcileDesktop = async (removedPaths: readonly string[] = []) => {
        try {
            const scan = await desktopCommand('scan_desktop');
            setConfig((p) => {
                if (!p) return p;
                return reconcileSnapshot(p, scan, removedPaths);
            });
        } catch {
            /* scan is best-effort; manual refresh can retry */
        }
    };

    // -- Load config, initial reconcile, watcher subscription ------------
    onMount(async () => {
        let loaded: DeskConfig;
        try {
            loaded = await desktopCommand('get_config');
        } catch {
            toast.error(t('toast.load_config_failed'));
            return;
        }
        try {
            // Do not render stale persisted desktop entries before the first
            // scan. A later manual refresh used to remove these entries, but
            // the initial asynchronous paint made them flash on startup.
            const scan = await desktopCommand('scan_desktop');
            setConfig(reconcileSnapshot(loaded, scan));
        } catch {
            // Keep the saved layout usable if the first native scan fails;
            // watcher events and manual Refresh will retry reconciliation.
            // Still clean duplicate entries left by older rename versions.
            setConfig(deduplicateConfigIcons(loaded));
            // Icons without a saved or Explorer position wait for the next scan.
            toast.error(t('toast.scan_failed'));
        }
    });

    onMount(() => {
        const unlisten = listen('desktop-changed', () => {
            void reconcileDesktop();
        });
        onCleanup(() => {
            void unlisten.then((fn) => fn());
        });
    });
    // -- Save config (debounced, not in frequent callbacks) ---------------
    // Every write is stamped with a monotonically increasing revision; the
    // backend ignores stale revisions so a debounced save already in flight
    // can never clobber a newer import/reset that landed afterwards.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saveRev = 0;
    const flushSave = () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        const cfg = config();
        return cfg ? desktopCommand('save_config', { cfg, rev: ++saveRev }) : Promise.resolve();
    };
    const installUpdate = async (version: string) => {
        await flushSave();
        await desktopCommand('install_update', { version });
        await desktopCommand('quit_app');
    };
    createEffect(() => {
        const cfg = config();
        if (!cfg) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            desktopCommand('save_config', { cfg, rev: ++saveRev }).catch(() => {});
        }, 300);
        onCleanup(() => clearTimeout(saveTimer!));
    });
    const exportConfig = async () => {
        const cfg = config();
        if (!cfg) return;
        try {
            const exported = await desktopCommand('export_config', { cfg });
            if (!exported) return;
            toast.success(t('toast.export_done'));
        } catch {
            toast.error(t('toast.export_failed'));
        }
    };

    const importConfig = async () => {
        try {
            const before = config();
            const imported = await desktopCommand('import_config', { rev: saveRev });
            if (!imported) return;
            setConfig(imported);
            await reconcileDesktop();
            const after = config();
            if (before && after) {
                pushHistoryEntry({
                    id: crypto.randomUUID(),
                    label: t('history.import'),
                    before: cloneConfig(before),
                    after: cloneConfig(after),
                });
            }
            // Persist the imported layout immediately (and with a fresh
            // revision) so an older debounced save cannot clobber it.
            void flushSave().catch(() => {});
            toast.success(t('toast.import_done'));
        } catch {
            toast.error(t('toast.import_failed'));
        }
    };

    const resetConfig = async () => {
        try {
            // Destructive (removes all cells) -> native confirm first
            if (!(await ask(t('settings.reset_confirm'), { kind: 'warning' }))) return;
            const before = config();
            setConfig(await desktopCommand('reset_config', { rev: saveRev }));
            await reconcileDesktop();
            const after = config();
            if (before && after) {
                pushHistoryEntry({
                    id: crypto.randomUUID(),
                    label: t('history.reset'),
                    before: cloneConfig(before),
                    after: cloneConfig(after),
                });
            }
            void flushSave().catch(() => {});
            toast.success(t('toast.reset_done'));
        } catch {
            toast.error(t('toast.load_config_failed'));
        }
    };

    return {
        config,
        setConfig,
        commitConfig,
        reconcileSnapshot,
        reconcileDesktop,
        history,
        undoLatest,
        redoLatest,
        cloneConfig,
        pushHistoryEntry,
        exportConfig,
        importConfig,
        resetConfig,
        installUpdate,
    };
}
