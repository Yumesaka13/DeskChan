import { onCleanup } from 'solid-js';

const MASK_FILL = 'linear-gradient(black, black)';

/** Cut the fence rectangles out of the free-icon layer, including under Acrylic. */
export function createFenceOcclusion() {
    const fences = new Set<HTMLElement>();
    let iconLayer: HTMLElement | undefined;
    const sizes = new ResizeObserver(update);
    const changes = new MutationObserver(update);

    function update() {
        if (!iconLayer) return;
        const regions = [...fences]
            .filter((fence) => fence.isConnected && fence.style.opacity !== '0')
            .map((fence) => fence.getBoundingClientRect())
            .filter(({ width, height }) => width > 0 && height > 0);
        if (!regions.length) {
            iconLayer.style.mask = '';
            return;
        }
        // Composite the fence masks into a union before subtracting from the
        // full desktop layer. Overlapping fences must still hide the icons.
        iconLayer.style.mask = [
            `${MASK_FILL} subtract`,
            ...regions.map(
                ({ left, top, width, height }) =>
                    `${MASK_FILL} ${left}px ${top}px / ${width}px ${height}px no-repeat add`,
            ),
        ].join(', ');
    }

    function watch(element: HTMLElement) {
        changes.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    }

    onCleanup(() => {
        sizes.disconnect();
        changes.disconnect();
    });

    return {
        setIconLayer(layer: HTMLElement) {
            iconLayer = layer;
            update();
        },
        registerFence(fence: HTMLElement) {
            fences.add(fence);
            sizes.observe(fence);
            watch(fence);
            onCleanup(() => {
                fences.delete(fence);
                sizes.unobserve(fence);
                changes.disconnect();
                for (const remaining of fences) watch(remaining);
                update();
            });
        },
    };
}
