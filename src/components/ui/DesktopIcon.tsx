/**
 * DesktopIcon - a single file icon, used both free on the desktop and inside
 * cells. Native-like behavior: single click selects, double click opens.
 *
 * The shell icon comes from Rust (256/48px source, see icon-cache) and is
 * displayed at 48px CSS like Windows' medium icons - downscaling a large
 * source keeps it crisp at any DPI. `createResource` keeps the icon URL
 * across SolidJS re-renders triggered by config changes.
 */
import { createEffect, createResource, createSignal, Show } from 'solid-js';
import { cn } from '~/lib/utils';
import { fetchIcon } from '~/lib/icon-cache';
import { displayIconName } from '~/lib/grid';
import type { DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import { FiFile } from 'solid-icons/fi';

export interface DesktopIconProps {
    icon: DesktopIconData;
    /** Double-click (native behavior) - opens the file */
    onOpen: (icon: DesktopIconData) => void;
    /** Single click - select (event exposes ctrl/meta for multi-select) */
    onSelect?: (icon: DesktopIconData, e: MouseEvent) => void;
    selected?: boolean;
    showFileExtensions?: boolean;
    showShortcutExtensions?: boolean;
    /** Compact row presentation used by cell list layout. */
    listLayout?: boolean;
    onDragStart?: (iconId: string, e: PointerEvent) => void;
    /** Right-click - shows the native Windows shell menu for the file */
    onNativeMenu?: (icon: DesktopIconData, event: MouseEvent) => void;
    /** Inline Explorer-style rename state, usually entered by F2 or menu. */
    editing?: boolean;
    onRename?: (icon: DesktopIconData, name: string) => void;
    onRenameCancel?: () => void;
    class?: string;
    iconClass?: string;
    labelClass?: string;
}

export default function DesktopIcon(props: DesktopIconProps) {
    const [iconUrl] = createResource(() => props.icon.path, fetchIcon);
    const displayName = () => displayIconName(
        props.icon,
        props.showFileExtensions ?? true,
        props.showShortcutExtensions ?? false,
    );
    const [draftName, setDraftName] = createSignal('');
    let inputRef!: HTMLInputElement;
    let cancelingRename = false;

    createEffect(() => {
        if (!props.editing) return;
        const name = displayName();
        setDraftName(name);
        queueMicrotask(() => {
            inputRef?.focus();
            const dot = name.lastIndexOf('.');
            inputRef?.setSelectionRange(0, dot > 0 ? dot : name.length);
        });
    });

    const commitRename = () => {
        if (cancelingRename) return;
        const next = draftName().trim();
        if (next && next !== displayName()) props.onRename?.(props.icon, next);
        else props.onRenameCancel?.();
    };
    const cancelRename = () => {
        cancelingRename = true;
        props.onRenameCancel?.();
        queueMicrotask(() => { cancelingRename = false; });
    };

    return (
        <div
            class={cn(
                'flex gap-0.5 p-1 rounded',
                props.listLayout ? 'flex-row items-center' : 'flex-col items-center',
                'cursor-default select-none',
                'border border-transparent',
                'hover:bg-blue-400/15 hover:border-blue-300/20',
                props.selected && 'bg-blue-400/30 border-blue-300/40',
                'w-18 group relative',
                props.class,
            )}
            onClick={(e) => {
                e.stopPropagation();
                if (!props.editing) props.onSelect?.(props.icon, e);
            }}
            onDblClick={(e) => {
                e.stopPropagation();
                if (!props.editing) props.onOpen(props.icon);
            }}
            onContextMenu={(e) => {
                if (props.onNativeMenu) {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onNativeMenu(props.icon, e);
                }
            }}
            onPointerDown={(e) => {
                if (!props.editing && props.onDragStart && e.button === 0) {
                    e.preventDefault();
                    props.onDragStart(props.icon.id, e);
                }
            }}
            title={displayName()}
        >
            <Show when={!props.listLayout}>
                <div class={cn('w-12 h-12 flex items-center justify-center overflow-hidden', props.iconClass)}>
                    <Show when={iconUrl()} fallback={<FiFile class="text-3xl text-gray-400 dark:text-gray-500" />}>
                        <img
                            src={iconUrl()!}
                            alt=""
                            class="w-full h-full object-contain"
                            draggable="false"
                        />
                    </Show>
                </div>
            </Show>
            <Show
                when={props.editing}
                fallback={
                    <span
                        class={cn(
                            'text-xs text-center leading-tight break-words max-w-full',
                            // A selected icon mirrors Explorer's focused-label
                            // behavior: reveal the complete name instead of keeping
                            // the compact two-line desktop label truncation.
                            props.selected ? 'line-clamp-none' : 'line-clamp-2',
                            'text-gray-700 dark:text-gray-200',
                            props.labelClass,
                        )}
                    >
                        {displayName()}
                    </span>
                }
            >
                <input
                    ref={inputRef}
                    value={draftName()}
                    onInput={(e) => setDraftName(e.currentTarget.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onDblClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') cancelRename();
                    }}
                    class={cn(
                        'w-full min-w-0 rounded-sm border border-blue-500 bg-white/95 px-1',
                        'text-xs leading-tight text-center text-gray-900 outline-none',
                        'dark:bg-gray-900/95 dark:text-gray-100',
                        props.listLayout && 'text-left',
                    )}
                />
            </Show>
        </div>
    );
}

export type { DesktopIconData };
