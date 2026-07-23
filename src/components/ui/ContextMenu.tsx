/**
 * ContextMenu — right-click contextual menu.
 * Renders at the cursor position and auto-closes on outside click.
 */
import { onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { cn } from '~/lib/utils';

export interface MenuItem {
    label: string;
    icon?: JSX.Element;
    /** Optional keyboard shortcut hint */
    shortcut?: string;
    disabled?: boolean;
    destructive?: boolean;
    onClick: () => void;
}

export interface ContextMenuProps {
    /** Menu items to display */
    items: MenuItem[];
    /** Position where the menu opened (clientX, clientY) */
    position: { x: number; y: number };
    /** Called when the menu should close */
    onClose: () => void;
    /** Override class for the menu container */
    class?: string;
}

/**
 * Context menu component. Must be used with Portal (rendered at body level).
 */
export default function ContextMenu(props: ContextMenuProps) {
    let menuRef!: HTMLDivElement;

    // Close on outside click — use mousedown + capture phase to avoid races
    const handleClickOutside = (e: MouseEvent) => {
        if (menuRef && !menuRef.contains(e.target as Node)) {
            e.stopPropagation();
            e.preventDefault();
            props.onClose();
        }
    };

    // Close on Escape key
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            props.onClose();
        }
    };

    // Use capture phase so we see events before SolidJS synthetic handlers
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('contextmenu', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);

    onCleanup(() => {
        document.removeEventListener('mousedown', handleClickOutside, true);
        document.removeEventListener('contextmenu', handleClickOutside, true);
        document.removeEventListener('keydown', handleKeyDown);
    });

    return (
        <Portal>
            <div
                ref={menuRef}
                class={cn(
                    'glass-panel context-menu-enter',
                    'fixed z-[9999] min-w-36 py-1',
                    'text-sm text-gray-800 dark:text-gray-100',
                    'pointer-events-auto',
                    props.class,
                )}
                style={{
                    left: `${props.position.x}px`,
                    top: `${props.position.y}px`,
                }}
                role="menu"
            >
                {props.items.map((item) => (
                    <button
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={() => {
                            if (!item.disabled) {
                                item.onClick();
                                props.onClose();
                            }
                        }}
                        class={cn(
                            'w-full flex items-center gap-2 px-3 py-1.5 text-left',
                            'hover:bg-gray-100 dark:hover:bg-gray-700/60',
                            'disabled:opacity-40 disabled:cursor-not-allowed',
                            item.destructive && 'text-red-500 dark:text-red-400',
                        )}
                    >
                        {item.icon && (
                            <span class="w-4 h-4 flex-shrink-0">{item.icon}</span>
                        )}
                        <span class="flex-1">{item.label}</span>
                        {item.shortcut && (
                            <span class="text-xs text-gray-400 dark:text-gray-500 ml-4">
                                {item.shortcut}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </Portal>
    );
}
