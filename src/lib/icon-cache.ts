/**
 * Global cache for shell file icons fetched from Rust.
 * Keyed by file path; concurrent requests are deduped, failures are not
 * cached (so a transient error retries on next mount).
 */
import { invoke } from '@tauri-apps/api/core';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** Synchronous lookup — used by the drag ghost. */
export function getCachedIcon(path: string): string | undefined {
    return cache.get(path);
}

export function fetchIcon(path: string): Promise<string> {
    const hit = cache.get(path);
    if (hit !== undefined) return Promise.resolve(hit);
    const inflight = pending.get(path);
    if (inflight) return inflight;
    const promise = invoke<string>('get_file_icon', { path })
        .then((url) => { cache.set(path, url); return url; })
        .catch(() => '')
        .finally(() => { pending.delete(path); });
    pending.set(path, promise);
    return promise;
}
