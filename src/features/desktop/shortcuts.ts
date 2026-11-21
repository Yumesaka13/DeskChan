import { onCleanup, onMount } from 'solid-js';
import { desktopCommand } from '~/platform/desktop-api';
import toast from 'solid-toast';
import type { DesktopFiles } from './files';
import type { DesktopSelection } from './selection';
import type { DesktopSession } from './session';
import type { Translate } from './types';

interface Shortcuts {
    files: DesktopFiles;
    selection: DesktopSelection;
    session: DesktopSession;
    isDialogOpen: () => boolean;
    openHistory: () => Promise<void>;
    openMenu: () => void;
    dismiss: () => void;
    t: Translate;
}

export function registerDesktopShortcuts({
    files,
    selection,
    session,
    isDialogOpen,
    openHistory,
    openMenu,
    dismiss,
    t,
}: Shortcuts) {
    onMount(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || isDialogOpen()) return;
            if (
                event.target instanceof HTMLElement &&
                (event.target.isContentEditable || event.target.matches('input, textarea, select'))
            )
                return;

            const key = event.key.toLowerCase();
            const primary = event.ctrlKey || event.metaKey;
            const run = (action: () => void) => {
                event.preventDefault();
                action();
            };

            if (event.ctrlKey && key === 'z') {
                run(() => {
                    if (event.altKey) void openHistory();
                    else void session.undoLatest();
                });
            } else if (event.ctrlKey && !event.altKey && key === 'y') {
                run(() => {
                    void session.redoLatest();
                });
            } else if (primary && key === 'v') {
                run(() => {
                    void files.pasteFromClipboard('auto');
                });
            } else if (primary && key === 'c') {
                const paths = selection.selectedPaths();
                if (paths.length)
                    run(() => {
                        void desktopCommand('file_action', { paths, action: 'copy' }).catch(() =>
                            toast.error(t('toast.file_action_failed')),
                        );
                    });
            } else if (key === 'delete') {
                const paths = selection.selectedPaths();
                if (paths.length)
                    run(() => {
                        void files.deletePaths(paths, event.shiftKey).then((deleted) => {
                            if (deleted) selection.setSelectedIds(new Set<string>());
                        });
                    });
            } else if (key === 'f2') {
                const [icon, ...others] = selection.selectedIcons();
                if (icon && !others.length) run(() => files.startRenameIcon(icon));
            } else if ((key === 'f10' && event.shiftKey) || key === 'contextmenu') {
                run(openMenu);
            } else if (key === 'escape') {
                dismiss();
            }
        };
        window.addEventListener('keydown', onKey);
        onCleanup(() => window.removeEventListener('keydown', onKey));
    });
}
