import { createMemo, For, Show, untrack, type Accessor } from 'solid-js';
import type { Cell } from '@bindings/Cell';
import { deleteSubCell } from '~/lib/cell';
import { effectiveCellRect } from '~/lib/grid';
import CellBox from '~/components/ui/CellBox';
import DesktopIcon from '~/components/ui/DesktopIcon';
import { useI18n } from '~/i18n';
import type { DesktopSession } from './session';
import type { DesktopSelection } from './selection';
import type { DesktopLayout } from './layout';
import type { DesktopFiles } from './files';
import type { createIconDrag } from './icon-drag';
import { createFenceOcclusion } from './fence-occlusion';

interface DesktopIconsProps {
    session: DesktopSession;
    selection: DesktopSelection;
    layout: DesktopLayout;
    files: DesktopFiles;
    drag: ReturnType<typeof createIconDrag>;
    wallpaperTint: Accessor<string | null>;
}

export default function DesktopIcons(props: DesktopIconsProps) {
    const { t } = useI18n();
    // The session controllers are created once by the desktop root.
    const { session, selection, layout, files, drag } = untrack(() => props);
    const { config } = session;
    const cells = createMemo(() => config()?.cells ?? []);
    const freeIcons = createMemo(() => config()?.free_icons ?? []);
    const cellsById = createMemo(() => new Map(cells().map((cell) => [cell.id, cell])));
    const iconsById = createMemo(() => new Map(freeIcons().map((icon) => [icon.id, icon])));
    const showExtensions = () => config()?.show_file_extensions ?? true;
    const showShortcutExtensions = () => config()?.show_shortcut_extensions ?? false;
    const selected = (id: string) => selection.selectedIds().has(id);
    const editing = (id: string) => files.renamingIconId() === id;
    const cancelRename = () => files.setRenamingIconId(null);
    const clear = () => selection.setSelectedIds(new Set<string>());
    const occlusion = createFenceOcclusion();

    return (
        <Show when={selection.contentVisible() && config()}>
            <For each={cells().map((cell) => cell.id)}>
                {(id) => {
                    const patch = (change: (cell: Cell) => Cell) => layout.updateCell(id, change);
                    return (
                        <Show when={cellsById().get(id)}>
                            {(cell) => (
                                <CellBox
                                    cell={cell()}
                                    hovered={layout.hoverCellId() === id}
                                    snapRects={cells()
                                        .filter((peer) => peer.id !== id)
                                        .map(effectiveCellRect)}
                                    wallpaperTint={props.wallpaperTint()}
                                    overlayOpacity={config()?.desktop_overlay_opacity ?? 0.01}
                                    showFileExtensions={showExtensions()}
                                    showShortcutExtensions={showShortcutExtensions()}
                                    onSurface={occlusion.registerFence}
                                    commands={{
                                        setRect: (rect) => patch((value) => ({ ...value, rect })),
                                        hover: (inside) => layout.cellHover(id, inside),
                                        toggleHover: () =>
                                            patch((value) => ({
                                                ...value,
                                                hover_expand: !value.hover_expand,
                                                collapsed: !value.hover_expand,
                                            })),
                                        toggleTitle: () =>
                                            patch((value) => ({ ...value, show_title: !value.show_title })),
                                        selectTab: (tab) =>
                                            patch((value) =>
                                                value.active_sub === tab
                                                    ? value
                                                    : { ...value, active_sub: tab },
                                            ),
                                        createTab: () => layout.createSubCell(id),
                                        renameTab: (tab, title) =>
                                            patch((value) =>
                                                tab
                                                    ? {
                                                          ...value,
                                                          sub_cells: value.sub_cells.map((sub) =>
                                                              sub.id === tab ? { ...sub, title } : sub,
                                                          ),
                                                      }
                                                    : { ...value, title },
                                            ),
                                        deleteTab: (tab) => patch((value) => deleteSubCell(value, tab)),
                                        sort: (field, direction) => {
                                            void layout.arrangeCellIcons(id, field, direction);
                                        },
                                        changeLayout: (mode) =>
                                            patch((value) => ({ ...value, layout: mode })),
                                        changeTabStyle: (style) =>
                                            patch((value) => ({ ...value, sub_style: style })),
                                        deleteCell: () => layout.removeCell(id),
                                    }}
                                    icons={{
                                        selected,
                                        editing,
                                        clear,
                                        cancelRename,
                                        open: files.openIcon,
                                        select: selection.selectIcon,
                                        rename: files.renameIcon,
                                        drag: (icon, event) => drag.start(icon, id, event),
                                        menu: (icon, event) => files.showFileMenu(icon, id, event),
                                    }}
                                />
                            )}
                        </Show>
                    );
                }}
            </For>
            <div class="desktop-files" ref={occlusion.setIconLayer}>
                <For each={freeIcons().map((icon) => icon.id)}>
                    {(id) => (
                        <Show when={iconsById().get(id)}>
                            {(icon) => (
                                <div
                                    data-icon
                                    data-icon-id={id}
                                    class="desktop-file"
                                    classList={{ 'desktop-file-selected': selected(id) }}
                                    style={{
                                        left: `${icon().pos_x}px`,
                                        top: `${icon().pos_y}px`,
                                        display: icon().pos_x < 0 || icon().pos_y < 0 ? 'none' : undefined,
                                    }}
                                >
                                    <DesktopIcon
                                        icon={icon()}
                                        selected={selected(id)}
                                        editing={editing(id)}
                                        showFileExtensions={showExtensions()}
                                        showShortcutExtensions={showShortcutExtensions()}
                                        onOpen={files.openIcon}
                                        onSelect={selection.selectIcon}
                                        onRename={files.renameIcon}
                                        onRenameCancel={cancelRename}
                                        onNativeMenu={(value, event) =>
                                            files.showFileMenu(value, undefined, event)
                                        }
                                        onDragStart={(_id, event) => drag.start(icon(), null, event)}
                                        labelClass="desktop-icon-label"
                                    />
                                </div>
                            )}
                        </Show>
                    )}
                </For>
            </div>
            <Show when={!cells().length && !freeIcons().length}>
                <div class="desktop-empty">
                    <p>{t('desktop.empty')}</p>
                </div>
            </Show>
        </Show>
    );
}
