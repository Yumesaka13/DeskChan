/**
 * DesktopIcon — a single file icon, used both free on the desktop and inside
 * cells. Native-like behavior: single click selects, double click opens.
 *
 * The shell icon comes from Rust (256/48px source, see icon-cache) and is
 * displayed at 48px CSS like Windows' medium icons — downscaling a large
 * source keeps it crisp at any DPI. `createResource` keeps the icon URL
 * across SolidJS re-renders triggered by config changes.
 */
import { createResource, Show } from 'solid-js';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { fetchIcon } from '~/lib/icon-cache';
import type { DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import { FiFile, FiX } from 'solid-icons/fi';

export interface DesktopIconProps {
    icon: DesktopIconData;
    /** Double-click (native behavior) — opens the file */
    onOpen: (icon: DesktopIconData) => void;
    /** Single click — select */
    onSelect?: (icon: DesktopIconData) => void;
    selected?: boolean;
    onRemove?: (icon: DesktopIconData) => void;
    onDragStart?: (iconId: string, e: PointerEvent) => void;
    class?: string;
    iconClass?: string;
    labelClass?: string;
}

export default function DesktopIcon(props: DesktopIconProps) {
    const { t } = useI18n();
    const [iconUrl] = createResource(() => props.icon.path, fetchIcon);

    return (
        <div
            class={cn(
                'flex flex-col items-center gap-0.5 p-1 rounded',
                'cursor-default select-none',
                'border border-transparent',
                'hover:bg-blue-400/15 hover:border-blue-300/20',
                props.selected && 'bg-blue-400/30 border-blue-300/40',
                'w-18 group relative',
                props.class,
            )}
            onClick={(e) => { e.stopPropagation(); props.onSelect?.(props.icon); }}
            onDblClick={(e) => { e.stopPropagation(); props.onOpen(props.icon); }}
            onPointerDown={(e) => {
                if (props.onDragStart && e.button === 0) {
                    e.preventDefault();
                    props.onDragStart(props.icon.id, e);
                }
            }}
            title={props.icon.name}
        >
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
            <span
                class={cn(
                    'text-xs text-center leading-tight break-words line-clamp-2 max-w-full',
                    'text-gray-700 dark:text-gray-200',
                    props.labelClass,
                )}
            >
                {props.icon.name}
            </span>
            {props.onRemove && (
                <button
                    onClick={(e) => { e.stopPropagation(); props.onRemove?.(props.icon); }}
                    class="absolute -top-1 -right-1 w-5 h-5 flex items-center justify-center rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 hover:bg-red-600"
                    title={t('icon.remove')}
                >
                    <FiX class="w-3 h-3" />
                </button>
            )}
        </div>
    );
}

export type { DesktopIconData };
