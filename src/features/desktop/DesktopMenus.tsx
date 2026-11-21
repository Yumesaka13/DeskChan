import { desktopCommand } from '~/platform/desktop-api';
import { untrack } from 'solid-js';
import toast from 'solid-toast';
import {
    FiCheck,
    FiCornerUpLeft,
    FiArrowDown,
    FiPlus,
    FiRefreshCw,
    FiSettings,
    FiPower,
    FiFile,
    FiGrid,
    FiImage,
    FiMonitor,
    FiMoreHorizontal,
    FiClipboard,
    FiCopy,
    FiMove,
    FiTrash2,
    FiEdit2,
    FiMinimize2,
} from 'solid-icons/fi';
import { useI18n } from '~/i18n';
import ContextMenu, { type MenuItem } from '~/components/ui/ContextMenu';
import { removeIcon } from '~/lib/cell';
import { arrangeFreeIcons, snapToGrid } from '~/lib/grid';
import type { DesktopSession } from './session';
import type { DesktopSelection } from './selection';
import type { DesktopLayout } from './layout';
import type { DesktopFiles } from './files';
import { viewportSize, type Point } from './types';

interface DesktopMenusProps {
    session: DesktopSession;
    selection: DesktopSelection;
    layout: DesktopLayout;
    files: DesktopFiles;
    contextMenu: Point | null;
    closeDesktopMenu: () => void;
    openSettingsDialog: () => Promise<void>;
}

export default function DesktopMenus(props: DesktopMenusProps) {
    const { t } = useI18n();
    const { session, selection, layout, files } = untrack(() => props);
    const { config, commitConfig, reconcileDesktop, history, undoLatest } = session;
    const { selectedIds, setSelectedIds } = selection;
    const { createNewCell, updateCell, sortDesktop, sortField, sortDirection, organizeDesktop } = layout;
    const {
        fileMenu,
        setFileMenu,
        fileMenuPaths,
        pasteFromClipboard,
        openIcon,
        openSettings,
        runFileAction,
        startRenameIcon,
        excludedFromOrganize,
        toggleOrganizeExclusion,
        showNativeIconMenu,
    } = files;
    const contextMenu = () => props.contextMenu;

    function desktopItems(): MenuItem[] {
        return [
            {
                label: t('desktop.context.arrangement'),
                icon: <FiGrid />,
                submenu: [
                    {
                        label: t('desktop.context.arrange_auto'),
                        icon: config()?.auto_arrange ? <FiCheck /> : undefined,
                        onClick: () =>
                            commitConfig(t('history.sort'), (current) => {
                                const next = { ...current, auto_arrange: !current.auto_arrange };
                                return next.auto_arrange ? arrangeFreeIcons(next, viewportSize()) : next;
                            }),
                    },
                    {
                        label: t('desktop.context.arrange_snap'),
                        icon: config()?.snap_to_grid ? <FiCheck /> : undefined,
                        onClick: () =>
                            commitConfig(t('history.sort'), (current) => {
                                const next = { ...current, snap_to_grid: !current.snap_to_grid };
                                if (!next.snap_to_grid) return next;
                                return {
                                    ...next,
                                    free_icons: next.free_icons.map((icon) => {
                                        if (icon.pos_x < 0 || icon.pos_y < 0) return icon;
                                        const { x, y } = snapToGrid(icon.pos_x, icon.pos_y);
                                        return { ...icon, pos_x: x, pos_y: y };
                                    }),
                                };
                            }),
                    },
                    { separator: true },
                    {
                        label: t('desktop.context.show_desktop'),
                        icon: <FiMinimize2 />,
                        shortcut: 'Win+D',
                        onClick: () => {
                            void desktopCommand('toggle_show_desktop').catch(() => {});
                        },
                    },
                ],
            },
            {
                label: t('desktop.context.sort_by'),
                icon: <FiArrowDown />,
                submenu: [
                    ...(['name', 'type', 'modified'] as const).map((field) => ({
                        label: t(`desktop.context.sort_${field}`),
                        icon: sortField() === field ? <FiCheck /> : undefined,
                        onClick: () => {
                            void sortDesktop(field, sortDirection());
                        },
                    })),
                    { separator: true },
                    ...(['asc', 'desc'] as const).map((direction) => ({
                        label: t(
                            direction === 'asc'
                                ? 'desktop.context.sort_ascending'
                                : 'desktop.context.sort_descending',
                        ),
                        icon: sortDirection() === direction ? <FiCheck /> : undefined,
                        onClick: () => {
                            void sortDesktop(sortField(), direction);
                        },
                    })),
                ],
            },
            {
                label: t('desktop.context.refresh'),
                icon: <FiRefreshCw />,
                onClick: () => {
                    setSelectedIds(new Set<string>());
                    void reconcileDesktop();
                },
            },
            { separator: true },
            {
                label: t('desktop.context.undo'),
                icon: <FiCornerUpLeft />,
                shortcut: 'Ctrl+Z',
                disabled: !history().undo.length,
                onClick: () => {
                    void undoLatest();
                },
            },
            {
                label: t('desktop.context.new'),
                icon: <FiPlus />,
                submenu: [
                    { label: t('desktop.context.new_cell'), icon: <FiGrid />, onClick: createNewCell },
                ],
            },
            {
                label: t('desktop.context.paste'),
                icon: <FiClipboard />,
                submenu: [
                    {
                        label: t('desktop.context.paste_copy'),
                        icon: <FiCopy />,
                        onClick: () => {
                            void pasteFromClipboard('copy');
                        },
                    },
                    {
                        label: t('desktop.context.paste_move'),
                        icon: <FiMove />,
                        onClick: () => {
                            void pasteFromClipboard('move');
                        },
                    },
                ],
            },
            { separator: true },
            {
                label: t('desktop.context.display_settings'),
                icon: <FiMonitor />,
                onClick: () => {
                    void openSettings('display');
                },
            },
            {
                label: t('desktop.context.personalize'),
                icon: <FiImage />,
                onClick: () => {
                    void openSettings('personalization');
                },
            },
            { separator: true },
            {
                label: t('desktop.context.deskchan'),
                icon: <FiSettings />,
                submenu: [
                    {
                        label: t('desktop.context.settings'),
                        icon: <FiSettings />,
                        onClick: () => {
                            void props.openSettingsDialog();
                        },
                    },
                    {
                        label: t('desktop.context.organize'),
                        icon: <FiGrid />,
                        onClick: () => {
                            void organizeDesktop();
                        },
                    },
                    { separator: true },
                    {
                        label: t('desktop.context.exit'),
                        icon: <FiPower />,
                        destructive: true,
                        onClick: () => {
                            void desktopCommand('quit_app').catch(() => {});
                        },
                    },
                ],
            },
            {
                label: t('desktop.context.system_menu'),
                icon: <FiMoreHorizontal />,
                onClick: () => {
                    void desktopCommand('show_desktop_menu', {}).catch(() =>
                        toast.error(t('toast.native_menu_failed')),
                    );
                },
            },
        ];
    }

    return (
        <>
            {/* Context menu */}
            {contextMenu() && (
                <ContextMenu
                    items={desktopItems()}
                    class="desktop-command-menu"
                    position={contextMenu()!}
                    onClose={() => props.closeDesktopMenu()}
                />
            )}

            {fileMenu() && (
                <ContextMenu
                    items={[
                        {
                            label: t('icon.open_file'),
                            icon: <FiFile />,
                            onClick: () => {
                                void openIcon(fileMenu()!.icon);
                            },
                        },
                        {
                            label: t('icon.open_with'),
                            icon: <FiMoreHorizontal />,
                            onClick: () => {
                                void runFileAction('open_with');
                            },
                        },
                        { separator: true } as const,
                        {
                            label: t('icon.cut'),
                            icon: <FiMove />,
                            onClick: () => {
                                void runFileAction('cut');
                            },
                        },
                        {
                            label: t('icon.copy'),
                            icon: <FiCopy />,
                            onClick: () => {
                                void runFileAction('copy');
                            },
                        },
                        {
                            label: t('icon.rename'),
                            icon: <FiEdit2 />,
                            shortcut: 'F2',
                            disabled: selectedIds().has(fileMenu()!.icon.id) && selectedIds().size !== 1,
                            onClick: () => startRenameIcon(fileMenu()!.icon),
                        },
                        {
                            label: t('icon.delete'),
                            icon: <FiTrash2 />,
                            destructive: true,
                            onClick: () => {
                                void runFileAction('delete');
                            },
                        },
                        { separator: true } as const,
                        ...(!fileMenu()!.cellId
                            ? [
                                  {
                                      label: t('icon.exclude_organize'),
                                      icon: excludedFromOrganize(fileMenuPaths()) ? <FiCheck /> : undefined,
                                      onClick: () => toggleOrganizeExclusion(fileMenuPaths()),
                                  },
                              ]
                            : []),
                        {
                            label: t('icon.properties'),
                            icon: <FiFile />,
                            onClick: () => {
                                void runFileAction('properties');
                            },
                        },
                        { separator: true } as const,
                        {
                            label: t('icon.system_menu'),
                            icon: <FiMoreHorizontal />,
                            onClick: () => {
                                void showNativeIconMenu(fileMenu()!.icon);
                            },
                        },
                        ...(fileMenu()!.cellId
                            ? [
                                  { separator: true } as const,
                                  {
                                      label: t('icon.remove'),
                                      icon: <FiTrash2 />,
                                      destructive: true,
                                      onClick: () =>
                                          updateCell(fileMenu()!.cellId!, (cell) =>
                                              removeIcon(cell, fileMenu()!.icon.id),
                                          ),
                                  },
                              ]
                            : []),
                    ]}
                    position={{ x: fileMenu()!.x, y: fileMenu()!.y }}
                    onClose={() => setFileMenu(null)}
                />
            )}
        </>
    );
}
