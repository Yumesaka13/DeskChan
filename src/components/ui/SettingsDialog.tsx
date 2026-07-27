/**
 * SettingsDialog — a modal settings dialog organized into tabs (kobalte
 * Tabs): General (language), Appearance (theme), and Data (export / import /
 * reset config). Every setting applies immediately — there is no save step.
 */
import { createSignal, Show } from 'solid-js';
import { Tabs } from '@kobalte/core/tabs';
import { cn } from '~/lib/utils';
import { useI18n } from '~/i18n';
import { useTheme } from '~/lib/theme';
import { FiX, FiDownload, FiUpload, FiTrash2 } from 'solid-icons/fi';

export interface SettingsDialogProps {
    /** Whether the dialog is visible */
    open: boolean;
    /** Called when the dialog should close */
    onClose: () => void;
    /** Called to export the current config to a user-chosen file */
    onExport: () => void;
    /** Called to import a config file chosen by the user */
    onImport: () => void;
    /** Called to reset the config to the first-run state (confirmed inside) */
    onReset: () => void;
    /** Override class for the overlay */
    overlayClass?: string;
    /** Override class for the dialog panel */
    panelClass?: string;
}

/** Shared look for the horizontal option buttons (theme / language). */
function OptionButton(props: {
    active: boolean;
    onClick: () => void;
    label: string;
}) {
    return (
        <button
            onClick={() => props.onClick()}
            class={cn(
                'flex-1',
                props.active
                    ? 'fluent-btn-accent'
                    : 'fluent-btn',
            )}
        >
            {props.label}
        </button>
    );
}

export default function SettingsDialog(props: SettingsDialogProps) {
    const { t, locale, setLocale } = useI18n();
    const { theme, setTheme } = useTheme();
    const [tab, setTab] = createSignal('general');

    // WinUI-style tab: quiet text with a rounded hover fill and an accent
    // underline pill marking the selected item
    const tabTrigger = (value: string, label: string) => (
        <Tabs.Trigger
            value={value}
            class={cn(
                'relative px-3 py-1.5 rounded text-sm transition-colors',
                'hover:bg-black/5 dark:hover:bg-white/8',
                tab() === value
                    ? 'text-gray-900 dark:text-gray-50 font-semibold'
                    : 'text-gray-500 dark:text-gray-400',
            )}
        >
            {label}
            <Show when={tab() === value}>
                <span class="absolute -bottom-px left-1/2 -translate-x-1/2 w-4 h-[3px] rounded-full bg-brand-primary dark:bg-brand-secondary" />
            </Show>
        </Tabs.Trigger>
    );

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
                    'glass-panel w-96 p-5 space-y-4',
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
                        onClick={() => props.onClose()}
                        class="fluent-icon-btn w-7 h-7"
                    >
                        <FiX class="w-4 h-4" />
                    </button>
                </div>

                <Tabs value={tab()} onChange={setTab}>
                    <Tabs.List class="flex gap-1 pb-3 border-b border-gray-200/60 dark:border-gray-600/40">
                        {tabTrigger('general', t('settings.tab.general'))}
                        {tabTrigger('appearance', t('settings.tab.appearance'))}
                        {tabTrigger('data', t('settings.tab.data'))}
                    </Tabs.List>

                    {/* General: language */}
                    <Tabs.Content value="general" class="pt-4 space-y-4 min-h-32">
                        <div class="space-y-1.5">
                            <label class="text-sm font-medium text-gray-600 dark:text-gray-300">
                                {t('settings.language')}
                            </label>
                            <div class="flex gap-2">
                                {(['zh-CN', 'en-US'] as const).map((lang) => (
                                    <OptionButton
                                        active={locale() === lang}
                                        onClick={() => setLocale(lang)}
                                        label={lang === 'zh-CN' ? '中文' : 'English'}
                                    />
                                ))}
                            </div>
                        </div>
                    </Tabs.Content>

                    {/* Appearance: theme (cell titles are per-cell, in the
                        cell's own context menu) */}
                    <Tabs.Content value="appearance" class="pt-4 space-y-4 min-h-32">
                        <div class="space-y-1.5">
                            <label class="text-sm font-medium text-gray-600 dark:text-gray-300">
                                {t('settings.theme')}
                            </label>
                            <div class="flex gap-2">
                                {(['light', 'dark', 'auto'] as const).map((tVal) => (
                                    <OptionButton
                                        active={theme() === tVal}
                                        onClick={() => setTheme(tVal)}
                                        label={t(`theme.${tVal}` as 'theme.light')}
                                    />
                                ))}
                            </div>
                        </div>
                    </Tabs.Content>

                    {/* Data: export / import / reset */}
                    <Tabs.Content value="data" class="pt-4 space-y-4 min-h-32">
                        <div class="flex gap-2">
                            <button
                                onClick={() => props.onExport()}
                                class="flex-1 flex items-center justify-center gap-2 fluent-btn"
                            >
                                <FiDownload class="w-4 h-4" />
                                {t('settings.export')}
                            </button>
                            <button
                                onClick={() => props.onImport()}
                                class="flex-1 flex items-center justify-center gap-2 fluent-btn"
                            >
                                <FiUpload class="w-4 h-4" />
                                {t('settings.import')}
                            </button>
                        </div>
                        <div class="space-y-1.5">
                            <button
                                onClick={() => props.onReset()}
                                class={cn(
                                    'w-full flex items-center justify-center gap-2 fluent-btn',
                                    'text-red-500 dark:text-red-400',
                                    'hover:bg-red-500/8 dark:hover:bg-red-400/10',
                                )}
                            >
                                <FiTrash2 class="w-4 h-4" />
                                {t('settings.reset')}
                            </button>
                            <p class="text-xs text-gray-400 dark:text-gray-500">
                                {t('settings.reset_hint')}
                            </p>
                        </div>
                    </Tabs.Content>
                </Tabs>

                {/* Actions — settings apply immediately, so closing is all */}
                <div class="flex justify-end pt-2">
                    <button onClick={() => props.onClose()} class="px-4 fluent-btn-accent">
                        {t('settings.close')}
                    </button>
                </div>
            </div>
            </div>
        </Show>
    );
}
