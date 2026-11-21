import { cursorPosition, getCurrentWindow, monitorFromPoint } from '@tauri-apps/api/window';

export interface Point {
    x: number;
    y: number;
}

export interface WorkArea {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export function viewportBounds(): WorkArea {
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

export async function workAreaAt(point?: Point): Promise<WorkArea> {
    try {
        const app = getCurrentWindow();
        const [origin, scale] = await Promise.all([app.innerPosition(), app.scaleFactor()]);
        const screen = point
            ? { x: origin.x + point.x * scale, y: origin.y + point.y * scale }
            : await cursorPosition();
        const monitor = await monitorFromPoint(screen.x, screen.y);
        if (monitor) {
            const { position, size } = monitor.workArea;
            const left = (position.x - origin.x) / scale;
            const top = (position.y - origin.y) / scale;
            return { left, top, right: left + size.width / scale, bottom: top + size.height / scale };
        }
    } catch {
        // A display may have disconnected while Tauri looked up its bounds.
    }
    return viewportBounds();
}

export function centerOf(area: WorkArea): Point {
    return { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
}
