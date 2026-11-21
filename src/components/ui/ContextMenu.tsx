/** Monitor-aware Fluent menu with keyboard navigation and nested commands. */
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { FiChevronRight } from 'solid-icons/fi';
import { viewportBounds, workAreaAt, type Point, type WorkArea } from '~/lib/monitor';
import { cn } from '~/lib/utils';
import { useNativeBackdrop } from '~/platform/NativeBackdrops';

export type MenuItem =
    | { separator: true }
    | {
          separator?: false;
          label: string;
          icon?: JSX.Element;
          shortcut?: string;
          disabled?: boolean;
          destructive?: boolean;
          onClick?: () => void;
          submenu?: MenuItem[];
      };

interface ContextMenuProps {
    items: MenuItem[];
    position: Point;
    onClose: () => void;
    class?: string;
    itemClass?: string;
}

interface Submenu {
    items: MenuItem[];
    trigger: HTMLButtonElement;
}

const INSET = 8;

function fit(value: number, size: number, start: number, end: number): number {
    return Math.max(start + INSET, Math.min(end - size - INSET, value));
}

function waitForMotion(elements: HTMLDivElement[]) {
    return Promise.allSettled(
        elements.flatMap((element) => element.getAnimations().map((animation) => animation.finished)),
    );
}

export default function ContextMenu(props: ContextMenuProps) {
    const [bounds, setBounds] = createSignal<WorkArea>(viewportBounds());
    const [submenus, setSubmenus] = createSignal<Submenu[]>([]);
    const [closing, setClosing] = createSignal(false);
    const [exiting, setExiting] = createSignal(false);
    const panels: { element: HTMLDivElement; suspend: () => Promise<void> | undefined }[] = [];
    let mounted = true;
    onCleanup(() => {
        mounted = false;
    });

    createEffect(() => {
        const point = props.position;
        let valid = true;
        void workAreaAt(point).then((area) => {
            if (valid) setBounds(area);
        });
        onCleanup(() => {
            valid = false;
        });
    });

    const enabledItems = (level: number) =>
        Array.from(
            panels[level]?.element.querySelectorAll<HTMLButtonElement>(
                'button[role="menuitem"]:not(:disabled)',
            ) ?? [],
        );
    const focusFirst = (level: number) => enabledItems(level)[0]?.focus({ preventScroll: true });

    onMount(() => {
        const previous = document.activeElement;
        const menu = panels[0]?.element;
        focusFirst(0);
        onCleanup(() => {
            if (menu?.contains(document.activeElement) || document.activeElement === document.body) {
                if (previous instanceof HTMLElement && previous.isConnected)
                    previous.focus({ preventScroll: true });
            }
        });
    });

    function open(items: MenuItem[], trigger: HTMLButtonElement, level: number, focus: boolean) {
        if (closing()) return;
        setSubmenus((current) =>
            current[level]?.trigger === trigger
                ? current
                : [...current.slice(0, level), { items, trigger }],
        );
        if (focus) queueMicrotask(() => focusFirst(level + 1));
    }

    function close(action?: () => void) {
        if (closing()) return;
        const onClose = props.onClose;
        const finish = () => {
            try {
                action?.();
            } finally {
                onClose();
            }
        };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finish();
            return;
        }
        setClosing(true);
        const dismiss = async () => {
            const openPanels = panels.filter(Boolean);
            await Promise.all(openPanels.map((panel) => panel.suspend()));
            if (!mounted) return;
            const elements = openPanels.map((panel) => panel.element);
            for (const element of elements) {
                const style = getComputedStyle(element);
                element.style.setProperty('--menu-exit-opacity', style.opacity);
                element.style.setProperty('--menu-exit-transform', style.transform);
            }
            setExiting(true);
            await waitForMotion(elements);
            if (mounted) finish();
        };
        void dismiss();
    }

    function activate(
        item: Extract<MenuItem, { label: string }>,
        trigger: HTMLButtonElement,
        level: number,
        focus: boolean,
    ) {
        if (item.submenu) {
            open(item.submenu, trigger, level, focus);
        } else if (item.onClick) {
            close(item.onClick);
        }
    }

    function keyboard(event: KeyboardEvent, level: number) {
        const items = enabledItems(level);
        const active = items.findIndex((item) => item === document.activeElement);
        const current = items[active];
        function handle(action: () => void) {
            event.preventDefault();
            event.stopPropagation();
            if (!closing()) action();
        }
        switch (event.key) {
            case 'ArrowDown':
                handle(() => items[(active + 1) % items.length]?.focus());
                break;
            case 'ArrowUp':
                handle(() =>
                    items[
                        active < 0 ? items.length - 1 : (active - 1 + items.length) % items.length
                    ]?.focus(),
                );
                break;
            case 'Home':
                handle(() => items[0]?.focus());
                break;
            case 'End':
                handle(() => items.at(-1)?.focus());
                break;
            case 'ArrowRight':
                if (current?.hasAttribute('aria-haspopup')) handle(() => current.click());
                break;
            case 'ArrowLeft':
                if (level > 0) {
                    const trigger = submenus()[level - 1]?.trigger;
                    handle(() => {
                        setSubmenus((menus) => menus.slice(0, level - 1));
                        trigger?.focus();
                    });
                }
                break;
            case 'Escape':
            case 'Tab':
                handle(close);
                break;
        }
    }

    function Panel(panel: { level: number; items: MenuItem[]; submenu?: Submenu }) {
        const [entered, setEntered] = createSignal(false);
        const backdrop = useNativeBackdrop('acrylic', entered);
        let ref!: HTMLDivElement;
        const [position, setPosition] = createSignal<Point & { direction?: 'left' | 'right' }>();
        onMount(() => {
            let active = true;
            void waitForMotion([ref]).then(() => {
                if (active && !untrack(closing)) setEntered(true);
            });
            onCleanup(() => {
                active = false;
                if (panels[panel.level]?.element === ref) delete panels[panel.level];
            });
        });
        createEffect(() => {
            const area = bounds();
            const initial = props.position;
            const submenu = panel.submenu;
            // Updating the command labels can change the panel's width.
            const items = panel.items;
            function place() {
                if (!ref?.isConnected || items.length === 0) return;
                const { offsetWidth: width, offsetHeight: height } = ref;
                const trigger = submenu?.trigger.getBoundingClientRect();
                const direction = trigger
                    ? trigger.right + width <= area.right - INSET
                        ? 'right'
                        : 'left'
                    : undefined;
                const x = trigger
                    ? direction === 'right'
                        ? trigger.right
                        : trigger.left - width
                    : initial.x;
                const y = trigger?.top ?? initial.y;
                setPosition({
                    x: fit(x, width, area.left, area.right),
                    y: fit(y, height, area.top, area.bottom),
                    direction,
                });
            }
            queueMicrotask(place);
        });
        return (
            <div
                ref={(element) => {
                    ref = element;
                    panels[panel.level] = { element, suspend: backdrop.suspend };
                    backdrop.ref(element);
                }}
                class={cn('fluent-flyout fluent-menu', props.class)}
                data-closing={closing() || undefined}
                data-motion={exiting() ? 'exit' : entered() ? undefined : 'enter'}
                data-opens-to={position()?.direction}
                role="menu"
                style={{
                    left: `${(position() ?? props.position).x}px`,
                    top: `${(position() ?? props.position).y}px`,
                    'max-height': `${Math.max(1, bounds().bottom - bounds().top - INSET * 2)}px`,
                    'max-width': `${Math.max(1, bounds().right - bounds().left - INSET * 2)}px`,
                }}
                onKeyDown={(event) => keyboard(event, panel.level)}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
            >
                <div class="fluent-menu-content">
                    <For each={panel.items}>
                        {(item) =>
                            item.separator ? (
                                <hr role="separator" class="fluent-menu-divider" />
                            ) : (
                                <button
                                    type="button"
                                    role="menuitem"
                                    tabIndex={-1}
                                    class={cn(
                                        'fluent-menu-item',
                                        item.destructive && 'settings-error',
                                        props.itemClass,
                                    )}
                                    disabled={item.disabled}
                                    aria-haspopup={item.submenu ? 'menu' : undefined}
                                    aria-expanded={
                                        item.submenu
                                            ? submenus()[panel.level]?.items === item.submenu
                                            : undefined
                                    }
                                    onClick={(event) =>
                                        activate(item, event.currentTarget, panel.level, true)
                                    }
                                    onMouseEnter={(event) => {
                                        if (closing()) return;
                                        if (item.submenu)
                                            open(item.submenu, event.currentTarget, panel.level, false);
                                        else setSubmenus((menus) => menus.slice(0, panel.level));
                                    }}
                                >
                                    <span class="fluent-menu-icon" aria-hidden="true">
                                        {item.icon}
                                    </span>
                                    <span class="fluent-menu-label">{item.label}</span>
                                    <Show when={item.shortcut}>
                                        <kbd class="fluent-menu-shortcut">{item.shortcut}</kbd>
                                    </Show>
                                    <Show when={item.submenu}>
                                        <FiChevronRight class="fluent-menu-chevron" aria-hidden="true" />
                                    </Show>
                                </button>
                            )
                        }
                    </For>
                </div>
            </div>
        );
    }

    return (
        <Portal>
            <div
                class="fluent-menu-dismiss"
                onPointerDown={() => close()}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }}
            />
            <Panel level={0} items={props.items} />
            <For each={submenus()}>
                {(submenu, index) => <Panel level={index() + 1} items={submenu.items} submenu={submenu} />}
            </For>
        </Portal>
    );
}
