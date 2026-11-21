import { createSignal, onCleanup } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import type { DesktopIcon as DIcon } from '@bindings/DesktopIcon';
import { dragRect, iconsInRect } from '~/lib/select';
import { toggleDesktopContentVisibility } from '~/lib/desktop-visibility';
import type { DesktopSession } from './session';
import { allConfigIcons } from './types';

export type DesktopSelection = ReturnType<typeof createDesktopSelection>;

export function createDesktopSelection({ config }: Pick<DesktopSession, 'config'>) {
    const [contentVisible, setContentVisible] = createSignal(true);
    const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set());
    const selectedIcons = () => {
        const cfg = config();
        if (!cfg) return [];
        return allConfigIcons(cfg).filter((icon) => selectedIds().has(icon.id));
    };

    // A drag that ends on the pressed icon still fires a trailing click,
    // which would collapse the fresh multi-selection to one icon - swallow it.
    let suppressNextClick = false;

    /** Plain click selects exclusively; ctrl/meta+click toggles membership. */
    const selectIcon = (ic: DIcon, e: MouseEvent) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        setSelectedIds((prev) => {
            if (e.ctrlKey || e.metaKey) {
                const next = new Set(prev);
                if (next.has(ic.id)) next.delete(ic.id);
                else next.add(ic.id);
                return next;
            }
            return new Set([ic.id]);
        });
    };

    // -- Marquee (rubber-band) selection over free icons ------------------
    const [marquee, setMarquee] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(
        null,
    );
    let marqueeAdditive = false; // ctrl held at start -> add to the selection
    let marqueeBase: ReadonlySet<string> = new Set();
    let endMarquee: (() => void) | undefined;
    onCleanup(() => endMarquee?.());

    const handleDesktopPointerDown = (e: PointerEvent) => {
        // Only start on the bare desktop background (button 0); icons and
        // cells are absolutely-positioned children, so target != currentTarget
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        endMarquee?.();
        marqueeAdditive = e.ctrlKey || e.metaKey;
        marqueeBase = selectedIds();
        setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
        // Freeze display sizing while a gesture is active.
        desktopCommand('set_dragging', { dragging: true }).catch(() => {});

        // The gesture can end OUTSIDE the window (the pointer is released
        // over the taskbar, which the overlay does not cover); a document
        // mouseup is then never delivered and `set_dragging` would stay
        // stuck at true. Track pointerleave and lost capture as fallbacks.
        const move = (ev: PointerEvent) => {
            const m = marquee();
            if (!m || ev.pointerId !== e.pointerId) return;
            const next = { ...m, x1: ev.clientX, y1: ev.clientY };
            setMarquee(next);
            // Live selection while dragging, like Explorer
            const hit = iconsInRect(
                config()?.free_icons ?? [],
                dragRect(next.x0, next.y0, next.x1, next.y1),
            );
            setSelectedIds(marqueeAdditive ? new Set([...marqueeBase, ...hit]) : new Set(hit));
        };
        const up = (event: PointerEvent) => {
            if (event.pointerId === e.pointerId) finish();
        };
        const finish = () => {
            if (endMarquee !== finish) return;
            endMarquee = undefined;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', finish);
            window.removeEventListener('pointerleave', finish);
            window.removeEventListener('lostpointercapture', finish);
            desktopCommand('set_dragging', { dragging: false }).catch(() => {});
            const m = marquee();
            setMarquee(null);
            // A sub-threshold drag is a plain empty-desktop click -> clear
            if (m && Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4 && !marqueeAdditive) {
                setSelectedIds(new Set<string>());
            }
        };
        endMarquee = finish;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', finish);
        window.addEventListener('pointerleave', finish);
        window.addEventListener('lostpointercapture', finish);
    };

    const handleDesktopDoubleClick = (e: MouseEvent) => {
        if (e.target !== e.currentTarget) return;
        setContentVisible((visible) => toggleDesktopContentVisibility(visible));
    };

    const selectedPaths = () => selectedIcons().map((icon) => icon.path);
    const setClickSuppressed = (value: boolean) => {
        suppressNextClick = value;
    };

    const cancelMarquee = () => {
        endMarquee?.();
    };

    return {
        selectedIds,
        setSelectedIds,
        selectedIcons,
        selectedPaths,
        selectIcon,
        setClickSuppressed,
        marquee,
        cancelMarquee,
        contentVisible,
        handleDesktopDoubleClick,
        handleDesktopPointerDown,
    };
}
