import { Show } from 'solid-js';
import { FiFile } from 'solid-icons/fi';
import { displayIconName } from '~/lib/grid';
import { dragRect } from '~/lib/select';
import { getCachedIcon } from '~/lib/icon-cache';
import type { DesktopSession } from './session';
import type { DesktopSelection } from './selection';
import type { createIconDrag } from './icon-drag';

interface GestureLayerProps {
    session: Pick<DesktopSession, 'config'>;
    selection: Pick<DesktopSelection, 'marquee'>;
    drag: ReturnType<typeof createIconDrag>;
}

export default function GestureLayer(props: GestureLayerProps) {
    const config = () => props.session.config();
    const marquee = () => props.selection.marquee();

    return (
        <>
            {/* Marquee rectangle - theme-aware, render only past the click threshold */}
            <Show when={marquee()}>
                {(m) => {
                    const r = () => dragRect(m().x0, m().y0, m().x1, m().y1);
                    return (
                        <Show when={r().width >= 4 || r().height >= 4}>
                            <div
                                class="desktop-selection"
                                style={{
                                    left: `${r().x}px`,
                                    top: `${r().y}px`,
                                    width: `${r().width}px`,
                                    height: `${r().height}px`,
                                }}
                            />
                        </Show>
                    );
                }}
            </Show>

            {/* Drag ghost - follows cursor once the drag threshold is passed */}
            <Show when={props.drag.preview()}>
                {(ds) => (
                    <Show when={ds().moved}>
                        <div
                            class="fixed z-[10000] pointer-events-none flex flex-col items-center gap-0.5 p-1 rounded opacity-80"
                            style={{
                                left: `${ds().x - ds().offsetX}px`,
                                top: `${ds().y - ds().offsetY}px`,
                                width: '72px',
                            }}
                        >
                            <div class="w-12 h-12 flex items-center justify-center">
                                <Show
                                    when={getCachedIcon(ds().icon.path)}
                                    fallback={<FiFile class="text-3xl text-gray-400 dark:text-gray-500" />}
                                >
                                    {(url) => (
                                        <img
                                            src={url()}
                                            alt=""
                                            class="w-full h-full object-contain"
                                            draggable="false"
                                        />
                                    )}
                                </Show>
                            </div>
                            <span class="text-xs text-center leading-tight line-clamp-2 max-w-full desktop-icon-label">
                                {displayIconName(
                                    ds().icon,
                                    config()?.show_file_extensions ?? true,
                                    config()?.show_shortcut_extensions ?? false,
                                )}
                            </span>
                            {/* Group size badge, like Explorer's drag count */}
                            <Show when={ds().group.length > 1}>
                                <span class="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-brand-primary text-white text-[10px] flex items-center justify-center tabular-nums">
                                    {ds().group.length}
                                </span>
                            </Show>
                        </div>
                    </Show>
                )}
            </Show>
        </>
    );
}
