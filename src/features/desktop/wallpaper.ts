import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import type { DesktopSession } from './session';

export function createWallpaperTint({ config }: Pick<DesktopSession, 'config'>) {
    const [wallpaperTintColor, setWallpaperTintColor] = createSignal<string | null>(null);
    const wallpaperTintEnabled = createMemo(() => config()?.wallpaper_tint ?? false);
    createEffect(() => {
        if (!wallpaperTintEnabled()) {
            setWallpaperTintColor(null);
            return;
        }

        let cancelled = false;
        let nextRefresh: number | undefined;
        const refresh = async () => {
            try {
                const color = await desktopCommand('get_wallpaper_color');
                if (!cancelled) setWallpaperTintColor(color || null);
            } catch {
                if (!cancelled) setWallpaperTintColor(null);
            } finally {
                if (!cancelled)
                    nextRefresh = window.setTimeout(() => {
                        void refresh();
                    }, 4000);
            }
        };

        void refresh();
        onCleanup(() => {
            cancelled = true;
            window.clearTimeout(nextRefresh);
        });
    });

    return wallpaperTintColor;
}
