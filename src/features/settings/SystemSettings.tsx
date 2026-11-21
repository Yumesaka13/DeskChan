import { createEffect, createSignal, on, Show } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import { FiDownload, FiRefreshCw } from 'solid-icons/fi';
import type { StartupMode } from '@bindings/StartupMode';
import SettingRow from '~/components/ui/SettingRow';
import { useI18n } from '~/i18n';

type UpdateState =
    | { status: 'idle' | 'checking' | 'current' | 'checkError' }
    | { status: 'available' | 'installing' | 'installError'; version: string };

interface SystemSettingsProps {
    open: boolean;
    onInstall: (version: string) => Promise<void>;
}

export default function SystemSettings(props: SystemSettingsProps) {
    const { t, locale, setLocale } = useI18n();
    const [startup, setStartup] = createSignal<StartupMode>();
    const [startupBusy, setStartupBusy] = createSignal(false);
    const [startupError, setStartupError] = createSignal(false);
    const [update, setUpdate] = createSignal<UpdateState>({ status: 'idle' });

    async function setStartupMode(mode?: StartupMode) {
        if (startupBusy() || (mode !== undefined && startup() === mode)) return;
        setStartupBusy(true);
        setStartupError(false);
        try {
            if (mode === undefined) setStartup(await desktopCommand('get_startup_mode'));
            else {
                await desktopCommand('set_startup_mode', { mode });
                setStartup(mode);
            }
        } catch (error) {
            console.error('Could not access DeskChan startup mode', error);
            setStartupError(true);
        } finally {
            setStartupBusy(false);
        }
    }
    createEffect(
        on(
            () => props.open,
            (open) => {
                if (open) void setStartupMode();
            },
        ),
    );

    async function checkUpdates() {
        setUpdate({ status: 'checking' });
        try {
            const version = await desktopCommand('check_for_updates');
            setUpdate(version ? { status: 'available', version } : { status: 'current' });
        } catch (error) {
            console.error('Could not check for DeskChan updates', error);
            setUpdate({ status: 'checkError' });
        }
    }

    async function installUpdate(version: string) {
        setUpdate({ status: 'installing', version });
        try {
            await props.onInstall(version);
        } catch (error) {
            console.error('Could not install the DeskChan update', error);
            setUpdate({ status: 'installError', version });
        }
    }
    const availableVersion = () => {
        const state = update();
        return 'version' in state ? state.version : null;
    };
    const updateCaption = () =>
        ({
            idle: '',
            checking: '',
            installing: '',
            current: t('settings.update_current'),
            available: t('settings.update_available'),
            checkError: t('settings.update_check_failed'),
            installError: t('settings.update_install_failed'),
        })[update().status];

    return (
        <>
            <h3 class="settings-page-title">{t('settings.tab.general')}</h3>
            <div class="settings-card">
                <SettingRow label={t('settings.language')}>
                    <div class="fluent-segments" role="group" aria-label={t('settings.language')}>
                        <button
                            type="button"
                            aria-pressed={locale() === 'zh-CN'}
                            onClick={() => setLocale('zh-CN')}
                        >
                            简体中文
                        </button>
                        <button
                            type="button"
                            aria-pressed={locale() === 'en-US'}
                            onClick={() => setLocale('en-US')}
                        >
                            English
                        </button>
                    </div>
                </SettingRow>
                <SettingRow
                    id="startup-mode"
                    label={t('settings.startup')}
                    description={t('settings.startup_hint')}
                >
                    <select
                        id="startup-mode"
                        class="fluent-select"
                        value={startup() ?? ''}
                        disabled={startupBusy() || startup() === undefined}
                        onChange={(event) => {
                            const mode = event.currentTarget.value;
                            event.currentTarget.value = startup() ?? '';
                            if (mode === 'off' || mode === 'normal' || mode === 'elevated')
                                void setStartupMode(mode);
                        }}
                    >
                        <Show when={startup() === undefined}>
                            <option value="">
                                {t(
                                    startupBusy()
                                        ? 'settings.startup_loading'
                                        : 'settings.startup_unavailable',
                                )}
                            </option>
                        </Show>
                        <option value="off">{t('settings.toggle_off')}</option>
                        <option value="normal">{t('settings.startup_normal')}</option>
                        <option value="elevated">{t('settings.startup_elevated')}</option>
                    </select>
                </SettingRow>
                <Show when={startupError()}>
                    <p role="status" class="settings-status settings-error">
                        {t('settings.startup_failed')}
                    </p>
                </Show>
            </div>
            <div class="settings-card settings-card-spaced">
                <SettingRow label={t('settings.updates')}>
                    <button
                        type="button"
                        class="fluent-btn"
                        aria-label={t('settings.update_check')}
                        disabled={update().status === 'checking' || update().status === 'installing'}
                        onClick={() => {
                            void checkUpdates();
                        }}
                    >
                        <FiRefreshCw size={16} aria-hidden="true" />
                        {t(
                            update().status === 'checking'
                                ? 'settings.update_checking'
                                : 'settings.update_check',
                        )}
                    </button>
                </SettingRow>
                <Show when={availableVersion()}>
                    {(version) => (
                        <SettingRow label={`DeskChan v${version()}`}>
                            <button
                                type="button"
                                class="fluent-btn-accent"
                                disabled={update().status === 'installing'}
                                onClick={() => {
                                    void installUpdate(version());
                                }}
                            >
                                <FiDownload size={16} aria-hidden="true" />
                                {t(
                                    update().status === 'installing'
                                        ? 'settings.update_installing'
                                        : 'settings.update_install',
                                )}
                            </button>
                        </SettingRow>
                    )}
                </Show>
                <Show when={updateCaption()}>
                    {(caption) => (
                        <p role="status" class="settings-status">
                            {caption()}
                        </p>
                    )}
                </Show>
            </div>
        </>
    );
}
