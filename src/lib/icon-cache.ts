/**
 * Global cache for shell file icons fetched from Rust.
 * Keyed by file path and physical size; concurrent requests are deduped, failures are not
 * cached (so a transient error retries on next mount).
 */
import { createSignal } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const [pixelRatio, setPixelRatio] = createSignal(window.devicePixelRatio);
let resolution: MediaQueryList;

function watchResolution() {
    setPixelRatio(window.devicePixelRatio);
    resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    resolution.addEventListener('change', watchResolution, { once: true });
}

watchResolution();
import.meta.hot?.dispose(() => resolution.removeEventListener('change', watchResolution));

export function fileIconSize(list = false): number {
    // Keep these tile sizes in sync with .file-tile-art in desktop.css.
    return Math.min(256, Math.round((list ? 20 : 48) * pixelRatio()));
}

function cacheKey(path: string, sizePx: number): string {
    return `${sizePx}:${path}`;
}

/** Synchronous lookup - used by the drag ghost. */
export function getCachedIcon(path: string): string | undefined {
    return cache.get(cacheKey(path, fileIconSize())) ?? cache.get(cacheKey(path, fileIconSize(true)));
}

export function fetchIcon(path: string, sizePx: number): Promise<string> {
    const key = cacheKey(path, sizePx);
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const promise = desktopCommand('get_file_icon', { path, sizePx })
        .then((url) => {
            cache.set(key, url);
            return url;
        })
        .catch(() => '')
        .finally(() => {
            pending.delete(key);
        });
    pending.set(key, promise);
    return promise;
}
