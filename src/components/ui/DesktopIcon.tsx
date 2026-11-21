/** File tile for the desktop grid and folder list views. */
import { createResource, Show } from 'solid-js';
import { FiFile } from 'solid-icons/fi';
import type { DesktopIcon as Icon } from '@bindings/DesktopIcon';
import { useI18n } from '~/i18n';
import { fetchIcon, fileIconSize } from '~/lib/icon-cache';
import { displayIconName } from '~/lib/grid';
import { cn } from '~/lib/utils';
import RenameInput from './RenameInput';

interface DesktopIconProps {
    icon: Icon;
    onOpen: (icon: Icon) => void;
    onSelect: (icon: Icon, event: MouseEvent) => void;
    onDragStart: (iconId: string, event: PointerEvent) => void;
    onNativeMenu: (icon: Icon, event: MouseEvent) => void;
    onRename: (icon: Icon, name: string) => void | Promise<void>;
    onRenameCancel: () => void;
    selected: boolean;
    showFileExtensions: boolean;
    showShortcutExtensions: boolean;
    listLayout?: boolean;
    editing?: boolean;
    class?: string;
    iconClass?: string;
    labelClass?: string;
}

export default function DesktopIcon(props: DesktopIconProps) {
    const { t } = useI18n();
    const [image] = createResource(
        () => ({ path: props.icon.path, sizePx: fileIconSize(props.listLayout) }),
        ({ path, sizePx }) => fetchIcon(path, sizePx),
    );
    const name = () => displayIconName(props.icon, props.showFileExtensions, props.showShortcutExtensions);

    return (
        <div
            class={cn('file-tile', props.listLayout && 'file-tile-row', props.class)}
            classList={{ 'file-tile-selected': props.selected }}
            role="button"
            aria-label={name()}
            aria-pressed={props.selected}
            tabIndex={props.editing ? -1 : 0}
            title={name()}
            onClick={(event) => {
                event.stopPropagation();
                if (!props.editing) props.onSelect(props.icon, event);
            }}
            onDblClick={(event) => {
                event.stopPropagation();
                if (!props.editing) props.onOpen(props.icon);
            }}
            onKeyDown={(event) => {
                if (props.editing) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === 'Enter') props.onOpen(props.icon);
                    else event.currentTarget.click();
                }
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onNativeMenu(props.icon, event);
            }}
            onPointerDown={(event) => {
                if (props.editing || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
                props.onDragStart(props.icon.id, event);
            }}
        >
            <div class={cn('file-tile-art', props.iconClass)} aria-hidden="true">
                <Show when={image()} fallback={<FiFile />}>
                    {(url) => <img src={url()} alt="" draggable="false" />}
                </Show>
            </div>
            <Show
                when={props.editing}
                fallback={<span class={cn('file-tile-name', props.labelClass)}>{name()}</span>}
            >
                <RenameInput
                    label={t('icon.rename')}
                    selectStem
                    value={name()}
                    onCommit={(value) => props.onRename(props.icon, value)}
                    onCancel={props.onRenameCancel}
                />
            </Show>
        </div>
    );
}
