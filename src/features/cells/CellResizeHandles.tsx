import { For, Show } from 'solid-js';
import type { ResizeEdges } from '~/lib/snap';

const sides = [
    { direction: 'w', edges: { w: true } },
    { direction: 'e', edges: { e: true } },
] satisfies { direction: string; edges: ResizeEdges }[];

const otherHandles = [
    { direction: 'n', edges: { n: true } },
    { direction: 's', edges: { s: true } },
    { direction: 'nw', edges: { n: true, w: true } },
    { direction: 'ne', edges: { n: true, e: true } },
    { direction: 'sw', edges: { s: true, w: true } },
    { direction: 'se', edges: { s: true, e: true } },
] satisfies { direction: string; edges: ResizeEdges }[];

export default function CellResizeHandles(props: {
    collapsed: boolean;
    start: (event: PointerEvent, edges: ResizeEdges) => void;
}) {
    const handle = (handle: { direction: string; edges: ResizeEdges }) => (
        <div
            class="cell-resize-handle"
            data-resize={handle.direction}
            aria-hidden="true"
            onPointerDown={(event) => props.start(event, handle.edges)}
        />
    );
    return (
        <>
            <For each={sides}>{handle}</For>
            <Show when={!props.collapsed}>
                <For each={otherHandles}>{handle}</For>
            </Show>
        </>
    );
}
