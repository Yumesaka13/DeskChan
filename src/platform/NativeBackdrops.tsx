import {
    createContext,
    createEffect,
    createSignal,
    onCleanup,
    onMount,
    useContext,
    type ParentProps,
} from 'solid-js';
import type { BackdropMaterial } from '@bindings/BackdropMaterial';
import type { BackdropSurface } from '@bindings/BackdropSurface';
import { desktopCommand } from './desktop-api';

interface BackdropRegistration {
    remove: () => void;
    suspend: () => Promise<void>;
    resume: () => void;
}

interface SurfaceEntry {
    element: HTMLElement;
    material: BackdropMaterial;
    suspension?: { done: Promise<void>; resolve: () => void };
}

type Register = (element: HTMLElement, material: BackdropMaterial) => BackdropRegistration;
const NativeBackdrops = createContext<Register>();

export function NativeBackdropProvider(props: ParentProps) {
    const surfaces = new Map<number, SurfaceEntry>();
    let sequence = 0;
    let frame = 0;
    let running = false;
    let pending = false;
    let stopped = false;
    const sizes = new ResizeObserver(schedule);
    const geometry = new MutationObserver(schedule);

    function schedule() {
        pending = true;
        if (!stopped && !running && !frame) frame = requestAnimationFrame(sync);
    }

    async function sync() {
        frame = 0;
        pending = false;
        running = true;
        const suspended = Array.from(surfaces.values(), (entry) => entry.suspension);
        try {
            const scale = window.devicePixelRatio;
            const visible = Array.from(surfaces, ([id, { element, material, suspension }]) => {
                const box = element.getBoundingClientRect();
                if (
                    suspension ||
                    !element.isConnected ||
                    !box.width ||
                    !box.height ||
                    element.style.opacity === '0'
                )
                    return null;
                const x = Math.floor(box.left * scale);
                const y = Math.floor(box.top * scale);
                const surface: BackdropSurface = {
                    id,
                    material,
                    x,
                    y,
                    width: Math.ceil(box.right * scale) - x,
                    height: Math.ceil(box.bottom * scale) - y,
                };
                return { surface, layer: Number(getComputedStyle(element).zIndex) || 0 };
            }).filter((entry) => entry !== null);
            visible.sort((left, right) => right.layer - left.layer || right.surface.id - left.surface.id);
            const applied = await desktopCommand('sync_backdrops', {
                surfaces: visible.map(({ surface }) => surface),
                dark: document.documentElement.classList.contains('dark'),
            });
            if (!stopped) reflect(applied ?? []);
        } catch {
            reflect([]);
        } finally {
            for (const suspension of suspended) suspension?.resolve();
            running = false;
            if (pending) schedule();
        }
    }

    function reflect(applied: number[]) {
        const shown = new Set(applied);
        for (const [id, { element, material, suspension }] of surfaces) {
            if (shown.has(id) && !suspension) element.dataset.nativeMaterial = material;
            else delete element.dataset.nativeMaterial;
        }
    }

    const register: Register = (element, material) => {
        const id = ++sequence;
        const entry: SurfaceEntry = { element, material };
        surfaces.set(id, entry);
        sizes.observe(element);
        geometry.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
        schedule();
        return {
            remove() {
                surfaces.delete(id);
                entry.suspension?.resolve();
                sizes.unobserve(element);
                // MutationObserver has no unobserve method.
                observeGeometry();
                delete element.dataset.nativeMaterial;
                schedule();
            },
            suspend() {
                if (entry.suspension) return entry.suspension.done;
                const { promise, resolve } = Promise.withResolvers<void>();
                entry.suspension = { done: promise, resolve };
                // Cover the active backing before asking the compositor to remove it.
                delete element.dataset.nativeMaterial;
                schedule();
                return promise;
            },
            resume() {
                entry.suspension = undefined;
                schedule();
            },
        };
    };

    function observeGeometry() {
        geometry.disconnect();
        const options = { attributes: true, attributeFilter: ['style', 'class'] };
        geometry.observe(document.documentElement, options);
        for (const { element } of surfaces.values()) geometry.observe(element, options);
    }

    onMount(() => {
        observeGeometry();
        window.addEventListener('resize', schedule);
        // Refresh on Windows transparency, contrast, or power-policy changes
        // even when the WebView did not receive a layout event.
        const policy = window.setInterval(() => {
            if (surfaces.size) schedule();
        }, 2000);
        onCleanup(() => {
            stopped = true;
            for (const entry of surfaces.values()) entry.suspension?.resolve();
            window.clearInterval(policy);
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', schedule);
            sizes.disconnect();
            geometry.disconnect();
        });
    });

    return <NativeBackdrops.Provider value={register}>{props.children}</NativeBackdrops.Provider>;
}

export function useNativeBackdrop(
    material: BackdropMaterial | (() => BackdropMaterial),
    active = () => true,
) {
    const register = useContext(NativeBackdrops);
    const [element, setElement] = createSignal<HTMLElement>();
    let registration: BackdropRegistration | undefined;
    createEffect(() => {
        const node = element();
        if (register && active() && node) {
            registration = register(node, typeof material === 'function' ? material() : material);
            onCleanup(() => {
                registration?.remove();
                registration = undefined;
            });
        }
    });
    return {
        ref: setElement,
        suspend: () => registration?.suspend(),
        resume: () => registration?.resume(),
    };
}
