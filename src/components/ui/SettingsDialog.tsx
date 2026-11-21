/** Fluent settings shell with tabbed system, appearance, and layout pages. */
import { createSignal } from 'solid-js';
import { Tabs } from '@kobalte/core/tabs';
import { FiDatabase, FiMonitor, FiSettings } from 'solid-icons/fi';
import { useI18n } from '~/i18n';
import { cn } from '~/lib/utils';
import type { WorkArea } from '~/lib/monitor';
import type { DesktopSession } from '~/features/desktop/session';
import SystemSettings from '~/features/settings/SystemSettings';
import AppearanceSettings from '~/features/settings/AppearanceSettings';
import LayoutSettings from '~/features/settings/LayoutSettings';
import FluentDialog from './FluentDialog';

interface SettingsDialogProps {
    open: boolean;
    onClose: () => void;
    area?: WorkArea;
    session: DesktopSession;
    class?: string;
    contentClass?: string;
}

export default function SettingsDialog(props: SettingsDialogProps) {
    const { t } = useI18n();
    const [page, setPage] = createSignal('general');
    return (
        <FluentDialog
            material="acrylic"
            open={props.open}
            onClose={props.onClose}
            area={props.area}
            title={t('settings.title')}
            class={cn('settings-dialog', props.class)}
            contentClass={cn('settings-dialog-content', props.contentClass)}
        >
            <Tabs class="settings-shell" value={page()} onChange={setPage}>
                <Tabs.List class="settings-nav" aria-label={t('settings.title')}>
                    <Tabs.Trigger class="settings-nav-item" value="general">
                        <FiSettings size={17} aria-hidden="true" />
                        {t('settings.tab.general')}
                    </Tabs.Trigger>
                    <Tabs.Trigger class="settings-nav-item" value="appearance">
                        <FiMonitor size={17} aria-hidden="true" />
                        {t('settings.tab.appearance')}
                    </Tabs.Trigger>
                    <Tabs.Trigger class="settings-nav-item" value="data">
                        <FiDatabase size={17} aria-hidden="true" />
                        {t('settings.tab.data')}
                    </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content class="settings-page" value="general" forceMount>
                    <SystemSettings open={props.open} onInstall={props.session.installUpdate} />
                </Tabs.Content>
                <Tabs.Content class="settings-page" value="appearance">
                    <AppearanceSettings session={props.session} />
                </Tabs.Content>
                <Tabs.Content class="settings-page" value="data">
                    <LayoutSettings session={props.session} />
                </Tabs.Content>
            </Tabs>
        </FluentDialog>
    );
}
