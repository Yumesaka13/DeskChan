import { createSignal } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import { ask } from '@tauri-apps/plugin-dialog';
import toast from 'solid-toast';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { sameParentDir } from '~/lib/select';
import type { DesktopSession } from './session';
import type { DesktopSelection } from './selection';
import { allConfigIcons, type Translate } from './types';

export type DesktopFiles = ReturnType<typeof createDesktopFiles>;

export function createDesktopFiles(
    session: DesktopSession,
    selection: DesktopSelection,
    closeDesktopMenu: () => void,
    t: Translate,
) {
    const { config, commitConfig, setConfig, reconcileSnapshot, pushHistoryEntry, cloneConfig } = session;
    const { selectedIds, selectedPaths, setSelectedIds } = selection;
    const [fileMenu, setFileMenu] = createSignal<{
        icon: DIcon;
        cellId?: string;
        x: number;
        y: number;
    } | null>(null);
    const [renamingIconId, setRenamingIconId] = createSignal<string | null>(null);
    let committingRenameIconId: string | null = null;
    const pasteFromClipboard = async (mode: 'auto' | 'copy' | 'move') => {
        try {
            const mutation = await desktopCommand('paste_from_clipboard_with_undo', { mode });
            if (mutation.paths.length > 0) {
                const scan = await desktopCommand('scan_desktop');
                // Derive from the CURRENT config: watcher reconciles that
                // landed while the clipboard was being read must survive.
                // A stale `before` snapshot would roll them back.
                const before = config();
                if (!before) return;
                const after = reconcileSnapshot(before, scan);
                setConfig(after);
                pushHistoryEntry({
                    id: crypto.randomUUID(),
                    label: t(mutation.record.kind === 'copy' ? 'history.file_copy' : 'history.file_move'),
                    before: cloneConfig(before),
                    after: cloneConfig(after),
                    file: mutation.record,
                });
            }
        } catch {
            toast.error(t('toast.paste_failed'));
        }
    };
    const openIcon = async (ic: DIcon) => {
        try {
            await desktopCommand('open_file', { path: ic.path });
        } catch {
            toast.error(t('toast.open_file_failed'));
        }
    };

    const openSettings = async (section: 'personalization' | 'display') => {
        try {
            await desktopCommand('open_settings', { section });
        } catch {
            toast.error(t('toast.open_settings_failed'));
        }
    };
    /** Native Windows shell context menu for an icon. For cell icons a
     *  "remove" entry is appended; free icons mirror real desktop files, so
     *  the native verbs (delete, rename, ...) plus the watcher cover them.
     *  Right-clicking inside a multi-selection opens the combined menu for
     *  all selected same-folder files (Explorer semantics); right-clicking
     *  an unselected icon selects just it first. */
    const nativeMenuPaths = (icon: DIcon) => {
        let paths = [icon.path];
        if (selectedIds().has(icon.id) && selectedIds().size > 1) {
            // Explorer's native menu needs one parent folder. The styled menu
            // still uses the shared selection for copy/delete, while the
            // system-menu fallback narrows only its shell invocation.
            const cfg = config();
            const sameDir = cfg
                ? allConfigIcons(cfg).filter(
                      (i) => selectedIds().has(i.id) && sameParentDir(i.path, icon.path),
                  )
                : [icon];
            paths = sameDir.map((i) => i.path);
        } else {
            setSelectedIds(new Set([icon.id]));
        }
        return paths;
    };

    const showNativeIconMenu = async (icon: DIcon) => {
        try {
            const paths = nativeMenuPaths(icon);
            const picked = await desktopCommand('show_icon_menu', {
                paths,
                extraItems: paths.length === 1 ? [t('icon.rename')] : [],
            });
            if (picked === 0) startRenameIcon(icon);
            return true;
        } catch {
            toast.error(t('toast.native_menu_failed'));
            return false;
        }
    };

    const excludedFromOrganize = (paths: string[]) => {
        const excluded = new Set(config()?.excluded_from_organize.map((path) => path.toLowerCase()) ?? []);
        return paths.length > 0 && paths.every((path) => excluded.has(path.toLowerCase()));
    };

    const toggleOrganizeExclusion = (paths: string[]) => {
        const keys = new Set(paths.map((path) => path.toLowerCase()));
        commitConfig(t('history.edit_cell'), (p) => {
            if (!p) return p;
            const excluded =
                keys.size > 0 &&
                [...keys].every((key) =>
                    p.excluded_from_organize.some((path) => path.toLowerCase() === key),
                );
            return {
                ...p,
                excluded_from_organize: excluded
                    ? p.excluded_from_organize.filter((path) => !keys.has(path.toLowerCase()))
                    : [
                          ...p.excluded_from_organize,
                          ...paths.filter(
                              (path) =>
                                  !p.excluded_from_organize.some(
                                      (existing) => existing.toLowerCase() === path.toLowerCase(),
                                  ),
                          ),
                      ],
            };
        });
    };
    const fileMenuPaths = () => {
        const menu = fileMenu();
        if (!menu) return [];
        return selectedIds().has(menu.icon.id) ? selectedPaths() : [menu.icon.path];
    };

    const startRenameIcon = (icon: DIcon) => {
        setFileMenu(null);
        closeDesktopMenu();
        setSelectedIds(new Set([icon.id]));
        setRenamingIconId(icon.id);
    };

    const renameIcon = async (icon: DIcon, name: string) => {
        if (committingRenameIconId === icon.id) return;
        const before = config();
        if (!before) return;
        committingRenameIconId = icon.id;
        try {
            const mutation = await desktopCommand('rename_desktop_icon_with_undo', {
                path: icon.path,
                name,
                preserveExtension: icon.path.toLowerCase().endsWith('.lnk')
                    ? !before.show_shortcut_extensions
                    : !before.show_file_extensions,
            });
            const oldPath = icon.path.toLowerCase();
            const updateIcon = (candidate: DIcon): DIcon =>
                candidate.path.toLowerCase() === oldPath
                    ? { ...candidate, path: mutation.path, name: mutation.name }
                    : candidate;
            // Apply to the CURRENT config so a watcher reconcile during the
            // rename isn't rolled back by the stale pre-rename snapshot.
            const current = config();
            if (!current) return;
            const after: DeskConfig = {
                ...current,
                free_icons: current.free_icons.map(updateIcon),
                excluded_from_organize: current.excluded_from_organize.map((path) =>
                    path.toLowerCase() === oldPath ? mutation.path : path,
                ),
                cells: current.cells.map((cell) => ({
                    ...cell,
                    icons: cell.icons.map(updateIcon),
                    sub_cells: cell.sub_cells.map((sub) => ({ ...sub, icons: sub.icons.map(updateIcon) })),
                })),
            };
            setConfig(after);
            pushHistoryEntry({
                id: crypto.randomUUID(),
                label: t('history.file_rename'),
                before: cloneConfig(current),
                after: cloneConfig(after),
                file: mutation.record,
            });
            setSelectedIds(new Set([icon.id]));
            setRenamingIconId(null);
        } catch {
            toast.error(t('toast.rename_failed'));
        } finally {
            committingRenameIconId = null;
        }
    };

    const runFileAction = async (action: 'open_with' | 'cut' | 'copy' | 'delete' | 'properties') => {
        const menu = fileMenu();
        if (!menu) return;
        try {
            const paths = fileMenuPaths();
            if (action === 'delete') await deletePaths(paths);
            else await desktopCommand('file_action', { paths, action });
        } catch {
            toast.error(t('toast.file_action_failed'));
        }
    };

    const deletePaths = async (paths: string[], permanent = false): Promise<boolean> => {
        if (paths.length === 0) return false;
        if (!permanent) {
            const message = paths.length === 1 ? t('confirm.delete_one') : t('confirm.delete_many');
            if (!(await ask(message, { kind: 'warning' }))) return false;
        }
        try {
            const mutation = await desktopCommand(
                permanent ? 'delete_permanently_with_undo' : 'delete_with_undo',
                { paths },
            );
            // The confirmation dialog can stay open for a long time; watcher
            // reconciles that happened meanwhile must not be rolled back by
            // applying a stale snapshot.
            const before = config();
            if (!before) return true;
            const removed = new Set(paths.map((path) => path.toLowerCase()));
            const after: DeskConfig = {
                ...before,
                free_icons: before.free_icons.filter((icon) => !removed.has(icon.path.toLowerCase())),
                cells: before.cells.map((cell) => ({
                    ...cell,
                    icons: cell.icons.filter((icon) => !removed.has(icon.path.toLowerCase())),
                    sub_cells: cell.sub_cells.map((sub) => ({
                        ...sub,
                        icons: sub.icons.filter((icon) => !removed.has(icon.path.toLowerCase())),
                    })),
                })),
            };
            setConfig(after);
            pushHistoryEntry({
                id: crypto.randomUUID(),
                label: permanent ? t('history.file_delete_permanent') : t('history.file_delete'),
                before: cloneConfig(before),
                after: cloneConfig(after),
                file: mutation.record,
            });
            return true;
        } catch {
            toast.error(t('toast.file_action_failed'));
            return false;
        }
    };

    const showFileMenu = (icon: DIcon, cellId: string | undefined, event: MouseEvent) => {
        const menu = { icon, cellId, x: event.clientX, y: event.clientY };
        if (!config()?.use_styled_file_menu) {
            void showNativeIconMenu(icon).then((shown) => {
                if (!shown) setFileMenu(menu);
            });
            return;
        }
        nativeMenuPaths(icon);
        setFileMenu(menu);
    };

    return {
        fileMenu,
        setFileMenu,
        fileMenuPaths,
        showFileMenu,
        showNativeIconMenu,
        runFileAction,
        openIcon,
        openSettings,
        renamingIconId,
        setRenamingIconId,
        startRenameIcon,
        renameIcon,
        pasteFromClipboard,
        deletePaths,
        excludedFromOrganize,
        toggleOrganizeExclusion,
    };
}
