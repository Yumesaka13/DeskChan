import { For } from 'solid-js';
import SettingRow from '~/components/ui/SettingRow';
import FluentSwitch from '~/components/ui/FluentSwitch';
import { useI18n } from '~/i18n';
import { useTheme } from '~/lib/theme';
import type { DesktopSession } from '~/features/desktop/session';

export default function AppearanceSettings(props: { session: DesktopSession }) {
    const { t } = useI18n();
    const { theme, setTheme } = useTheme();
    const config = () => props.session.config();
    const setConfig = (
        update: (current: ReturnType<DesktopSession['config']>) => ReturnType<DesktopSession['config']>,
    ) => props.session.setConfig(update);
    const opacity = () => Math.round((config()?.desktop_overlay_opacity ?? 0.01) * 100);
    return (
        <>
            <h3 class="settings-page-title">{t('settings.tab.appearance')}</h3>
            <div class="settings-card">
                <SettingRow label={t('settings.theme')}>
                    <div class="fluent-segments" role="group" aria-label={t('settings.theme')}>
                        <For each={['light', 'dark', 'auto'] as const}>
                            {(option) => (
                                <button
                                    type="button"
                                    aria-pressed={theme() === option}
                                    onClick={() => setTheme(option)}
                                >
                                    {t(`theme.${option}`)}
                                </button>
                            )}
                        </For>
                    </div>
                </SettingRow>
                <SettingRow label={t('settings.wallpaper_tint')}>
                    <FluentSwitch
                        label={t('settings.wallpaper_tint')}
                        checked={config()?.wallpaper_tint ?? false}
                        onChange={(wallpaper_tint) => setConfig((p) => p && { ...p, wallpaper_tint })}
                    />
                </SettingRow>
                <SettingRow id="desktop-opacity" label={t('settings.desktop_opacity')}>
                    <div class="settings-slider">
                        <input
                            type="range"
                            id="desktop-opacity"
                            min="1"
                            max="50"
                            step="1"
                            value={opacity()}
                            onInput={(event) => {
                                const desktop_overlay_opacity = Number(event.currentTarget.value) / 100;
                                setConfig((p) => p && { ...p, desktop_overlay_opacity });
                            }}
                        />
                        <output for="desktop-opacity">{opacity()}%</output>
                    </div>
                </SettingRow>
            </div>
            <div class="settings-card settings-card-spaced">
                <SettingRow label={t('settings.file_extensions')}>
                    <FluentSwitch
                        label={t('settings.file_extensions')}
                        checked={config()?.show_file_extensions ?? true}
                        onChange={(show_file_extensions) =>
                            setConfig((p) => p && { ...p, show_file_extensions })
                        }
                    />
                </SettingRow>
                <SettingRow label={t('settings.shortcut_extensions')}>
                    <FluentSwitch
                        label={t('settings.shortcut_extensions')}
                        checked={config()?.show_shortcut_extensions ?? false}
                        onChange={(show_shortcut_extensions) =>
                            setConfig((p) => p && { ...p, show_shortcut_extensions })
                        }
                    />
                </SettingRow>
                <SettingRow id="file-menu-style" label={t('settings.file_menu')}>
                    <select
                        id="file-menu-style"
                        class="fluent-select"
                        onChange={(event) => {
                            const use_styled_file_menu = event.currentTarget.value === 'styled';
                            setConfig((p) => p && { ...p, use_styled_file_menu });
                        }}
                    >
                        <option value="styled" selected={config()?.use_styled_file_menu !== false}>
                            {t('settings.file_menu_styled')}
                        </option>
                        <option value="native" selected={config()?.use_styled_file_menu === false}>
                            {t('settings.file_menu_native')}
                        </option>
                    </select>
                </SettingRow>
            </div>
        </>
    );
}
