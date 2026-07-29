/**
 * One-click organize: sort every free icon into categorized cells
 * (folders / apps / documents / images / media / archives / others),
 * Coodesker-style. Pure logic - testable without Tauri.
 *
 * Re-running organize merges into existing same-title cells instead of
 * creating duplicates; user-made cells and their icons are never touched.
 */
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { Cell } from '@bindings/Cell';
import type { Size } from './grid';

export type CategoryKey =
    | 'folders'
    | 'apps'
    | 'documents'
    | 'images'
    | 'media'
    | 'archives'
    | 'others';

/** Display order of the generated cells. */
const CATEGORY_ORDER: CategoryKey[] = [
    'folders', 'apps', 'documents', 'images', 'media', 'archives', 'others',
];

const EXT_OF: Record<CategoryKey, string[]> = {
    folders: [], // determined by the desktop scan, not by extension
    apps: ['exe', 'lnk', 'url', 'bat', 'cmd', 'msc', 'msi', 'appref-ms'],
    documents: [
        'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'rtf',
        'csv', 'odt', 'ods', 'odp', 'one', 'epub', 'mobi', 'json', 'xml', 'log',
    ],
    images: [
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico',
        'tif', 'tiff', 'heic', 'avif', 'psd',
    ],
    media: [
        'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
        'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'mid',
    ],
    archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab'],
    others: [],
};

const EXT_CATEGORY: ReadonlyMap<string, CategoryKey> = new Map(
    (Object.entries(EXT_OF) as [CategoryKey, string[]][])
        .flatMap(([cat, exts]) => exts.map((e) => [e, cat] as const)),
);

/** Categorize one icon. `dirPaths` = lowercased paths known to be folders. */
export function categorize(icon: DesktopIcon, dirPaths: ReadonlySet<string>): CategoryKey {
    if (dirPaths.has(icon.path.toLowerCase())) return 'folders';
    const base = icon.path.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return 'others'; // no extension and not a known folder
    return EXT_CATEGORY.get(base.slice(dot + 1).toLowerCase()) ?? 'others';
}

// -- Cell layout ------------------------------------------------------------

const CELL_W = 320;
const GAP = 24;
const MARGIN = 40;
const ICONS_PER_ROW = 4; // (320 - padding) / 76px slots
const ICON_ROW_H = 92;
const HEADER_H = 44; // title bar + content padding

/** Cell height that fits `count` icons, clamped to sane bounds. */
function cellHeight(count: number): number {
    const rows = Math.max(1, Math.ceil(count / ICONS_PER_ROW));
    return Math.min(420, HEADER_H + 16 + rows * ICON_ROW_H);
}

/**
 * Sort all free icons into category cells. Same-title cells are reused
 * (icons appended); new cells flow left-to-right from the top-left corner,
 * wrapping at the viewport edge.
 */
export function organizeConfig(
    cfg: DeskConfig,
    dirPaths: ReadonlySet<string>,
    excludedPaths: ReadonlySet<string>,
    viewport: Size,
    titles: Record<CategoryKey, string>,
): DeskConfig {
    if (cfg.free_icons.length === 0) return cfg;

    const buckets = new Map<CategoryKey, DesktopIcon[]>();
    const free_icons: DesktopIcon[] = [];
    for (const icon of cfg.free_icons) {
        if (excludedPaths.has(icon.path.toLowerCase())) {
            free_icons.push(icon);
            continue;
        }
        const cat = categorize(icon, dirPaths);
        buckets.set(cat, [...(buckets.get(cat) ?? []), icon]);
    }

    const cells = cfg.cells.map((c) => ({ ...c }));
    const newCells: Cell[] = [];
    // Flowing placement cursor for newly created cells
    let curX = MARGIN;
    let curY = MARGIN;
    let rowMaxH = 0;

    for (const cat of CATEGORY_ORDER) {
        const icons = buckets.get(cat);
        if (!icons?.length) continue;

        // Merge into an existing cell with the same title (repeat organize)
        const existing = cells.find((c) => c.title === titles[cat]);
        if (existing) {
            existing.icons = [...existing.icons, ...icons];
            continue;
        }

        const height = cellHeight(icons.length);
        if (curX + CELL_W > viewport.width - MARGIN && curX > MARGIN) {
            curX = MARGIN;
            curY += rowMaxH + GAP;
            rowMaxH = 0;
        }
        newCells.push({
            id: crypto.randomUUID(),
            title: titles[cat],
            rect: { x: curX, y: curY, width: CELL_W, height },
            background_color: null,
            opacity: 0.85,
            layout: 'Grid',
            sort_field: 'name',
            sort_direction: 'asc',
            collapsed: false,
            hover_expand: false,
            icons,
            sub_cells: [],
            active_sub: null,
            sub_style: 'Compact',
            show_title: true,
        });
        curX += CELL_W + GAP;
        rowMaxH = Math.max(rowMaxH, height);
    }

    return { ...cfg, cells: [...cells, ...newCells], free_icons };
}
