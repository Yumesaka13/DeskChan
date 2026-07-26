/**
 * SettingsDialog — a modal dialog for app settings (theme, language, etc.).
 */
import { createEffect, createSignal, Show, untrack } from 'solid-js';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { useTheme } from '~/lib/theme';
import { FiX } from 'solid-icons/fi';

export interface SettingsDialogProps {
    /** Whether the dialog is visible */
    open: boolean;
    /** Called when the dialog should close */
    onClose: () => void;
    /** Called when settings are saved */
    onSave: (settings: { showTitles: boolean }) => void;
    /** Current show-titles setting */
    showTitles: boolean;
    /** Override class for the overlay */
    overlayClass?: string;
    /** Override class for the dialog panel */
    panelClass?: string;
}

/**
 * Settings modal with theme toggle, language switch, and show-titles toggle.
 */
export default function SettingsDialog(props: SettingsDialogProps) {
    const { t, locale, setLocale } = useI18n();
    const { theme, setTheme } = useTheme();
    const [showTitles, setShowTitles] = createSignal(props.showTitles);

    // Re-sync from the config on the closed→open edge only — the signal's
    // initial value is captured at mount, before the config even loads, but
    // syncing continuously would clobber unsaved toggles when unrelated
    // config updates (watcher reconciles, cell moves) land mid-edit.
    let wasOpen = false;
    createEffect(() => {
        const open = props.open;
        if (open && !wasOpen) setShowTitles(untrack(() => props.showTitles));
        wasOpen = open;
    });

    const handleSave = () => {
        props.onSave({ showTitles: showTitles() });
        props.onClose();
    };

    return (
        <Show when={props.open}>
        <div
            class={cn(
                'fixed inset-0 z-50 flex items-center justify-center',
                'bg-black/30 backdrop-blur-sm',
                props.overlayClass,
            )}
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div
                class={cn(
                    'glass-panel w-80 p-5 space-y-4',
                    'context-menu-enter',
                    props.panelClass,
                )}
            >
                {/* Header */}
                <div class="flex items-center justify-between">
                    <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">
                        {t('settings.title')}
                    </h2>
                    <button
                        onClick={props.onClose}
                        class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                    >
                        <FiX class="w-4 h-4" />
                    </button>
                </div>

                {/* Theme */}
                <div class="space-y-1.5">
                    <label class="text-sm font-medium text-gray-600 dark:text-gray-300">
                        {t('settings.theme')}
                    </label>
                    <div class="flex gap-2">
                        {(['light', 'dark', 'auto'] as const).map((tVal) => (
                            <button
                                onClick={() => setTheme(tVal)}
                                class={cn(
                                    'flex-1 px-3 py-1.5 rounded-lg text-sm',
                                    'border border-gray-300 dark:border-gray-600',
                                    'hover:bg-gray-100 dark:hover:bg-gray-700',
                                    theme() === tVal &&
                                        'bg-brand-primary text-white border-brand-primary',
                                )}
                            >
                                {t(`theme.${tVal}` as 'theme.light')}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Language */}
                <div class="space-y-1.5">
                    <label class="text-sm font-medium text-gray-600 dark:text-gray-300">
                        {t('settings.language')}
                    </label>
                    <div class="flex gap-2">
                        {(['zh-CN', 'en-US'] as const).map((lang) => (
                            <button
                                onClick={() => setLocale(lang)}
                                class={cn(
                                    'flex-1 px-3 py-1.5 rounded-lg text-sm',
                                    'border border-gray-300 dark:border-gray-600',
                                    'hover:bg-gray-100 dark:hover:bg-gray-700',
                                    locale() === lang &&
                                        'bg-brand-primary text-white border-brand-primary',
                                )}
                            >
                                {lang === 'zh-CN' ? '中文' : 'English'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Show Titles */}
                <div class="flex items-center justify-between">
                    <span class="text-sm font-medium text-gray-600 dark:text-gray-300">
                        {t('settings.show_titles')}
                    </span>
                    <button
                        role="switch"
                        aria-checked={showTitles()}
                        onClick={() => setShowTitles((v) => !v)}
                        class={cn(
                            'relative w-10 h-5 rounded-full transition-colors',
                            showTitles()
                                ? 'bg-brand-primary'
                                : 'bg-gray-300 dark:bg-gray-600',
                        )}
                    >
                        <span
                            class={cn(
                                'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                                showTitles() ? 'left-5' : 'left-0.5',
                            )}
                        />
                    </button>
                </div>

                {/* Actions */}
                <div class="flex justify-end gap-2 pt-2">
                    <button
                        onClick={props.onClose}
                        class={cn(
                            'px-4 py-1.5 rounded-lg text-sm',
                            'border border-gray-300 dark:border-gray-600',
                            'hover:bg-gray-100 dark:hover:bg-gray-700',
                        )}
                    >
                        {t('settings.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        class={cn(
                            'px-4 py-1.5 rounded-lg text-sm text-white',
                            'bg-brand-primary hover:bg-brand-primary/80',
                        )}
                    >
                        {t('settings.save')}
                    </button>
                </div>
            </div>
            </div>
        </Show>
    );
}
