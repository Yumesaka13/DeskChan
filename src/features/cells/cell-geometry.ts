import { batch, createSignal, onCleanup } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import type { CellRect } from '@bindings/CellRect';
import { snapPosition, snapResizeRect, type ResizeEdges } from '~/lib/snap';
import type { Point } from '~/lib/monitor';

const MIN_SIZE = { minWidth: 120, minHeight: 80 };

interface GeometryOptions {
    rect: () => CellRect;
    visibleHeight: () => number;
    neighbors: () => CellRect[];
    commit: (rect: CellRect) => void;
    suspendBackdrop: () => Promise<void> | undefined;
    resumeBackdrop: () => void;
}

interface Gesture {
    start: Point;
    pointer: number;
    rect: CellRect;
    height: number;
    neighbors: CellRect[];
    edges?: ResizeEdges;
    handoff?: Promise<void>;
    finishing?: boolean;
}

function resize(
    rect: CellRect,
    { x: dx, y: dy }: Point,
    edges: ResizeEdges,
    neighbors: CellRect[],
): CellRect {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const x = edges.w ? Math.max(0, Math.min(rect.x + dx, right - MIN_SIZE.minWidth)) : rect.x;
    const y = edges.n ? Math.max(0, Math.min(rect.y + dy, bottom - MIN_SIZE.minHeight)) : rect.y;
    const width = edges.e ? Math.max(MIN_SIZE.minWidth, rect.width + dx) : right - x;
    const height = edges.s ? Math.max(MIN_SIZE.minHeight, rect.height + dy) : bottom - y;
    return snapResizeRect({ x, y, width, height }, edges, neighbors, MIN_SIZE);
}

function gestureFlag(dragging: boolean) {
    void desktopCommand('set_dragging', { dragging }).catch(() => {});
}

export function createCellGeometry(options: GeometryOptions) {
    const [preview, setPreview] = createSignal<CellRect>();
    const [previewReady, setPreviewReady] = createSignal(false);
    const [mode, setMode] = createSignal<'move' | 'resize'>();
    let gesture: Gesture | undefined;

    function start(event: PointerEvent, edges?: ResizeEdges) {
        if (event.button !== 0 || gesture || !(event.target instanceof Element)) return;
        gesture = {
            start: { x: event.clientX, y: event.clientY },
            pointer: event.pointerId,
            rect: options.rect(),
            height: options.visibleHeight(),
            neighbors: options.neighbors(),
            edges,
        };
        event.stopPropagation();
        event.target.setPointerCapture(event.pointerId);
        setMode(edges ? 'resize' : 'move');
        gestureFlag(true);
    }

    function move(event: PointerEvent) {
        if (!gesture || gesture.finishing || event.pointerId !== gesture.pointer) return;
        const { rect, start, edges, neighbors, height } = gesture;
        const delta = { x: event.clientX - start.x, y: event.clientY - start.y };
        if (!preview() && (edges ? delta.x === 0 && delta.y === 0 : Math.hypot(delta.x, delta.y) < 3))
            return;
        if (!preview()) {
            const current = gesture;
            current.handoff = options.suspendBackdrop();
            if (current.handoff) {
                void current.handoff.then(() => {
                    if (gesture === current) setPreviewReady(true);
                });
            } else {
                setPreviewReady(true);
            }
        }
        if (edges) {
            setPreview(resize(rect, delta, edges, neighbors));
        } else {
            const next = snapPosition(rect.x + delta.x, rect.y + delta.y, rect.width, height, neighbors);
            setPreview({ ...rect, x: Math.max(0, next.x), y: Math.max(0, next.y) });
        }
    }

    function finish(event?: PointerEvent, commit = false) {
        const current = gesture;
        if (!current || current.finishing || (event && event.pointerId !== current.pointer)) return;
        const previous = current.rect;
        const next = preview();
        const changed =
            next &&
            (next.x !== previous.x ||
                next.y !== previous.y ||
                next.width !== previous.width ||
                next.height !== previous.height);
        const complete = () => {
            if (gesture !== current) return;
            gesture = undefined;
            batch(() => {
                if (commit && changed) options.commit(next);
                setPreview(undefined);
                setPreviewReady(false);
                setMode(undefined);
            });
            if (current.handoff) options.resumeBackdrop();
            gestureFlag(false);
        };
        // A quick pointer release can precede the native window being hidden.
        if (commit && changed && current.handoff && !previewReady()) {
            current.finishing = true;
            void current.handoff.then(complete);
        } else {
            complete();
        }
    }

    onCleanup(() => {
        if (gesture) {
            gesture = undefined;
            gestureFlag(false);
        }
    });
    return {
        rect: () => (previewReady() ? preview() : undefined) ?? options.rect(),
        mode,
        start,
        move,
        commit: (event: PointerEvent) => finish(event, true),
        cancel: (event: PointerEvent) => finish(event),
    };
}
