/**
 * DesktopIcon — file shortcut inside a cell.
 *
 * Fetches the real system file icon via Rust's SHGetFileInfoW.
 * Uses SolidJS `createResource` (the reactive hook for async data)
 * so the icon URL survives component re-renders triggered by config changes.
 * Results are cached globally to avoid redundant IPC calls.
 */
import { createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import type { DesktopIcon as DesktopIconData } from '@bindings/DesktopIcon';
import { FiFile, FiX } from 'solid-icons/fi';

// ── Global icon cache ──────────────────────────────────────────────────────

const iconCache = new Map<string, string>();
const pendingRequests = new Map<string, Promise<string>>();

async function fetchIcon(path: string): Promise<string> {
    if (iconCache.has(path)) return iconCache.get(path)!;
    if (pendingRequests.has(path)) return pendingRequests.get(path)!;
    const promise = invoke<string>('get_file_icon', { path })
        .then((url) => { iconCache.set(path, url); pendingRequests.delete(path); return url; })
        .catch(() => { pendingRequests.delete(path); return ''; });
    pendingRequests.set(path, promise);
    return promise;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface DesktopIconProps {
    icon: DesktopIconData;
    onOpen: (icon: DesktopIconData) => void;
    onRemove?: (icon: DesktopIconData) => void;
    class?: string;
    iconClass?: string;
    labelClass?: string;
}

/**
 * `createResource` produces a reactive signal from an async fetcher.
 * The signal persists across SolidJS re-renders — unlike DOM refs which
 * get clobbered when JSX re-evaluates `src=""`.
 */
export default function DesktopIcon(props: DesktopIconProps) {
    const { t } = useI18n();

    // SolidJS hook: async resource tied to the component's reactive scope.
    // Re-fetches only if props.icon.path changes (which it won't for a given icon).
    const [iconUrl] = createResource(() => props.icon.path, fetchIcon);

    const name = props.icon.name;
    const truncated = name.length > 12 ? name.slice(0, 10) + '\u2026' : name;

    return (
        <div
            class={cn(
                'flex flex-col items-center gap-0.5 p-1.5 rounded-lg',
                'cursor-pointer select-none',
                'hover:bg-white/40 dark:hover:bg-gray-700/40',
                'w-18 group relative',
                props.class,
            )}
            onClick={(e) => { e.stopPropagation(); props.onOpen(props.icon); }}
            title={props.icon.name}
            draggable="true"
            onDragStart={(e) => {
                e.dataTransfer?.setData('application/deskchan-icon', props.icon.id);
                e.dataTransfer?.setData('text/plain', props.icon.id); // fallback for WebView2 compat
                e.dataTransfer!.effectAllowed = 'move';
            }}
        >
            <div class={cn('w-10 h-10 flex items-center justify-center overflow-hidden', props.iconClass)}>
                <Show when={iconUrl()} fallback={<FiFile class="text-xl text-gray-400 dark:text-gray-500" />}>
                    {/* 32px source → 16px CSS display for crisp HiDPI downsampling */}
                    <img
                        src={iconUrl()!}
                        alt=""
                        class="w-4 h-4 object-contain"
                        style="image-rendering: -webkit-optimize-contrast; image-rendering: crisp-edges;"
                        draggable="false"
                    />
                </Show>
            </div>
            <span class={cn('text-xs text-center text-gray-700 dark:text-gray-200 leading-tight break-all max-w-full line-clamp-2', props.labelClass)}>
                {truncated}
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
