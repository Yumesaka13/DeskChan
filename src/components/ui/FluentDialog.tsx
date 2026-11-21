/** Focus-managed Fluent dialog positioned on the monitor where it was opened. */
import { createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { Dialog } from '@kobalte/core/dialog';
import { FiX } from 'solid-icons/fi';
import { useI18n } from '~/i18n';
import { centerOf, viewportBounds, type Point, type WorkArea } from '~/lib/monitor';
import { cn } from '~/lib/utils';
import { useNativeBackdrop } from '~/platform/NativeBackdrops';
import type { BackdropMaterial } from '@bindings/BackdropMaterial';

interface FluentDialogProps {
    open: boolean;
    title: string;
    onClose: () => void;
    area?: WorkArea;
    dismissOutside?: boolean;
    material?: BackdropMaterial;
    class?: string;
    contentClass?: string;
    children: JSX.Element;
}

export default function FluentDialog(props: FluentDialogProps) {
    const { t } = useI18n();
    const backdrop = useNativeBackdrop(
        () => props.material ?? 'mica',
        () => props.open,
    );
    const [position, setPosition] = createSignal<Point | null>(null);
    const bounds = () => props.area ?? viewportBounds();
    createEffect(() => {
        if (props.open) setPosition(centerOf(bounds()));
    });
    createEffect(() => {
        if (!props.open) return;
        const dismiss = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
        };
        // Tab switches can remove the previously focused field. Escape still
        // needs to close the modal if focus briefly falls back to the document.
        window.addEventListener('keydown', dismiss, true);
        onCleanup(() => window.removeEventListener('keydown', dismiss, true));
    });
    let panel!: HTMLDivElement;
    let grip: { pointer: number; dx: number; dy: number } | null = null;

    function begin(event: PointerEvent & { currentTarget: HTMLElement }) {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button')))
            return;
        const anchor = position() ?? centerOf(bounds());
        grip = { pointer: event.pointerId, dx: event.clientX - anchor.x, dy: event.clientY - anchor.y };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function move(event: PointerEvent) {
        if (grip?.pointer !== event.pointerId) return;
        const area = bounds();
        const { width, height } = panel.getBoundingClientRect();
        const halfWidth = Math.min(width / 2, (area.right - area.left) / 2);
        const halfHeight = Math.min(height / 2, (area.bottom - area.top) / 2);
        setPosition({
            x: Math.max(area.left + halfWidth, Math.min(area.right - halfWidth, event.clientX - grip.dx)),
            y: Math.max(area.top + halfHeight, Math.min(area.bottom - halfHeight, event.clientY - grip.dy)),
        });
    }

    return (
        <Dialog
            open={props.open}
            onOpenChange={(open) => {
                if (!open) props.onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay
                    class="fluent-scrim"
                    onContextMenu={(event: MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                />
                <Dialog.Content
                    ref={(element: HTMLDivElement) => {
                        panel = element;
                        backdrop.ref(element);
                    }}
                    class={cn('fluent-dialog', props.class)}
                    style={{
                        left: `${(position() ?? centerOf(bounds())).x}px`,
                        top: `${(position() ?? centerOf(bounds())).y}px`,
                        'max-width': `${Math.max(1, bounds().right - bounds().left - 24)}px`,
                        'max-height': `${Math.max(1, bounds().bottom - bounds().top - 24)}px`,
                    }}
                    onInteractOutside={(event) => {
                        if (!props.dismissOutside) event.preventDefault();
                    }}
                    onPointerDown={(event: PointerEvent) => event.stopPropagation()}
                    onContextMenu={(event: MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    <header
                        class="fluent-dialog-header"
                        onPointerDown={begin}
                        onPointerMove={move}
                        onLostPointerCapture={() => {
                            grip = null;
                        }}
                    >
                        <Dialog.Title class="fluent-dialog-title">{props.title}</Dialog.Title>
                        <Dialog.CloseButton
                            class="fluent-icon-btn dialog-close"
                            aria-label={t('settings.close')}
                        >
                            <FiX size={18} />
                        </Dialog.CloseButton>
                    </header>
                    <div class={cn('fluent-dialog-content', props.contentClass)}>{props.children}</div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog>
    );
}
