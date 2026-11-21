import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { Translations } from '~/i18n';
import { allIcons } from '~/lib/cell';

export type Translate = (key: keyof Translations) => string;
export interface Point {
    x: number;
    y: number;
}

export function viewportSize() {
    return { width: window.innerWidth, height: window.innerHeight };
}

export function allConfigIcons(config: DeskConfig): DesktopIcon[] {
    return [...config.free_icons, ...config.cells.flatMap(allIcons)];
}
