import { createSignal } from 'solid-js';
import SettingsDialog from '~/components/ui/SettingsDialog';
import { useI18n } from '~/i18n';
import { centerOf, viewportBounds, workAreaAt, type Point, type WorkArea } from '~/lib/monitor';
import DesktopIcons from './DesktopIcons';
import DesktopMenus from './DesktopMenus';
import GestureLayer from './GestureLayer';
import HistoryDialog from './HistoryDialog';
import { createDesktopFiles } from './files';
import { createIconDrag } from './icon-drag';
import { registerIncomingDrop } from './incoming-drop';
import { createDesktopLayout } from './layout';
import { createDesktopSelection } from './selection';
import { createDesktopSession } from './session';
import { registerDesktopShortcuts } from './shortcuts';
import { createWallpaperTint } from './wallpaper';
import { desktopCommand } from '~/platform/desktop-api';
import toast from 'solid-toast';

type Panel = { kind: 'settings' | 'history'; area: WorkArea };

export default function Desktop() {
    const { t } = useI18n();
    const [menu, setMenu] = createSignal<Point | null>(null);
    const [panel, setPanel] = createSignal<Panel | null>(null);
    const closeMenu = () => setMenu(null);
    const closePanel = () => setPanel(null);

    const session = createDesktopSession(t);
    const selection = createDesktopSelection(session);
    const layout = createDesktopLayout(session, t);
    const files = createDesktopFiles(session, selection, closeMenu, t);
    const drag = createIconDrag(session, layout, selection, t);
    const wallpaperTint = createWallpaperTint(session);

    let systemMenuOpen = false;
    async function openMenu(point: Point) {
        if (systemMenuOpen) return;
        files.setFileMenu(null);
        if (session.config()?.use_styled_file_menu !== false) {
            setMenu(point);
            return;
        }
        closeMenu();
        const extras = [
            { label: t('desktop.context.new_cell'), action: layout.createNewCell },
            { label: t('desktop.context.settings'), action: () => openPanel('settings', point) },
            { label: t('desktop.context.organize'), action: layout.organizeDesktop },
            { label: t('desktop.context.exit'), action: () => desktopCommand('quit_app') },
        ];
        systemMenuOpen = true;
        try {
            const selected = await desktopCommand('show_desktop_menu', {
                extraItems: extras.map(({ label }) => label),
            });
            if (selected !== null) await extras[selected]?.action();
        } catch {
            toast.error(t('toast.native_menu_failed'));
            setMenu(point);
        } finally {
            systemMenuOpen = false;
        }
    }

    async function openPanel(kind: Panel['kind'], point?: Point) {
        const area = await workAreaAt(point);
        setPanel({ kind, area });
    }

    registerIncomingDrop(session, layout, t);
    registerDesktopShortcuts({
        files,
        selection,
        session,
        t,
        isDialogOpen: () => panel() !== null,
        openHistory: () => openPanel('history'),
        openMenu: () => {
            void openMenu(centerOf(viewportBounds()));
        },
        dismiss: () => {
            drag.cancel();
            closeMenu();
            files.setFileMenu(null);
            files.setRenamingIconId(null);
            selection.cancelMarquee();
            selection.setSelectedIds(new Set<string>());
        },
    });

    return (
        <main
            class="desktop-surface"
            aria-label="DeskChan"
            onPointerDown={selection.handleDesktopPointerDown}
            onDblClick={selection.handleDesktopDoubleClick}
            onContextMenu={(event) => {
                event.preventDefault();
                void openMenu({ x: event.clientX, y: event.clientY });
            }}
        >
            <DesktopIcons
                session={session}
                layout={layout}
                selection={selection}
                files={files}
                drag={drag}
                wallpaperTint={wallpaperTint}
            />
            <DesktopMenus
                session={session}
                layout={layout}
                selection={selection}
                files={files}
                contextMenu={menu()}
                closeDesktopMenu={closeMenu}
                openSettingsDialog={() => openPanel('settings', menu() ?? undefined)}
            />
            <GestureLayer session={session} selection={selection} drag={drag} />
            <SettingsDialog
                session={session}
                open={panel()?.kind === 'settings'}
                area={panel()?.area}
                onClose={closePanel}
            />
            <HistoryDialog
                session={session}
                open={panel()?.kind === 'history'}
                area={panel()?.area}
                onClose={closePanel}
            />
        </main>
    );
}
