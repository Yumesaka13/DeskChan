import { createSignal, For, Show } from 'solid-js';
import { FiRotateCcw } from 'solid-icons/fi';
import FluentDialog from '~/components/ui/FluentDialog';
import { useI18n } from '~/i18n';
import type { WorkArea } from '~/lib/monitor';
import type { DesktopSession } from './session';

interface HistoryDialogProps {
    open: boolean;
    area?: WorkArea;
    onClose: () => void;
    session: DesktopSession;
}

export default function HistoryDialog(props: HistoryDialogProps) {
    const { t } = useI18n();
    const [busy, setBusy] = createSignal(false);

    async function undoThrough(id: string) {
        if (busy()) return;
        setBusy(true);
        try {
            while (props.session.history().undo.some((entry) => entry.id === id)) {
                if (!(await props.session.undoLatest())) return;
            }
            props.onClose();
        } finally {
            setBusy(false);
        }
    }

    return (
        <FluentDialog
            open={props.open}
            onClose={props.onClose}
            area={props.area}
            title={t('history.title')}
            class="history-dialog"
            dismissOutside
        >
            <Show
                when={props.session.history().undo.length}
                fallback={<p class="settings-empty">{t('history.empty')}</p>}
            >
                <ol class="history-list">
                    <For each={[...props.session.history().undo].reverse()}>
                        {(entry) => (
                            <li>
                                <button
                                    type="button"
                                    class="history-action"
                                    disabled={busy()}
                                    onClick={() => {
                                        void undoThrough(entry.id);
                                    }}
                                >
                                    <FiRotateCcw size={16} aria-hidden="true" />
                                    <span>{entry.label}</span>
                                </button>
                            </li>
                        )}
                    </For>
                </ol>
            </Show>
        </FluentDialog>
    );
}
