import { FiDownload, FiTrash2, FiUpload } from 'solid-icons/fi';
import SettingRow from '~/components/ui/SettingRow';
import { useI18n } from '~/i18n';
import type { DesktopSession } from '~/features/desktop/session';

export default function LayoutSettings(props: { session: DesktopSession }) {
    const { t } = useI18n();
    return (
        <>
            <h3 class="settings-page-title">{t('settings.tab.data')}</h3>
            <div class="settings-card">
                <SettingRow label={t('settings.export')}>
                    <button
                        type="button"
                        class="fluent-btn"
                        onClick={() => {
                            void props.session.exportConfig();
                        }}
                    >
                        <FiDownload size={16} aria-hidden="true" />
                        {t('settings.export')}
                    </button>
                </SettingRow>
                <SettingRow label={t('settings.import')}>
                    <button
                        type="button"
                        class="fluent-btn"
                        onClick={() => {
                            void props.session.importConfig();
                        }}
                    >
                        <FiUpload size={16} aria-hidden="true" />
                        {t('settings.import')}
                    </button>
                </SettingRow>
                <SettingRow label={t('settings.reset')} description={t('settings.reset_hint')}>
                    <button
                        type="button"
                        class="fluent-btn settings-error"
                        onClick={() => {
                            void props.session.resetConfig();
                        }}
                    >
                        <FiTrash2 size={16} aria-hidden="true" />
                        {t('settings.reset')}
                    </button>
                </SettingRow>
            </div>
        </>
    );
}
