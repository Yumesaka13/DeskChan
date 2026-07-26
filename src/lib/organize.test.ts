import { describe, expect, it } from 'vitest';
import type { DeskConfig } from '@bindings/DeskConfig';
import type { DesktopIcon } from '@bindings/DesktopIcon';
import type { Cell } from '@bindings/Cell';
import { categorize, organizeConfig, type CategoryKey } from './organize';

const VIEWPORT = { width: 1920, height: 1080 };

const TITLES: Record<CategoryKey, string> = {
    folders: '文件夹', apps: '应用', documents: '文档', images: '图片',
    media: '影音', archives: '压缩包', others: '其他',
};

function icon(path: string): DesktopIcon {
    return { id: path, name: path, path, icon_path: null, pos_x: 0, pos_y: 0 };
}

function cell(title: string, icons: DesktopIcon[] = []): Cell {
    return {
        id: `cell-${title}`, title,
        rect: { x: 900, y: 500, width: 320, height: 240 },
        background_color: null, opacity: 0.85, layout: 'Grid', collapsed: false,
        icons,
    };
}

function cfg(partial?: Partial<DeskConfig>): DeskConfig {
    return {
        version: 3, cells: [], free_icons: [], auto_arrange: false,
        snap_to_grid: true, show_titles: true, theme: 'auto',
        ...partial,
    };
}

describe('categorize', () => {
    const dirs = new Set(['c:\\desktop\\myfolder']);
    it.each<[string, CategoryKey]>([
        ['C:\\Desktop\\MyFolder', 'folders'],
        ['C:\\Desktop\\app.exe', 'apps'],
        ['C:\\Desktop\\shortcut.lnk', 'apps'],
        ['C:\\Desktop\\report.pdf', 'documents'],
        ['C:\\Desktop\\notes.md', 'documents'],
        ['C:\\Desktop\\photo.JPG', 'images'],
        ['C:\\Desktop\\movie.mkv', 'media'],
        ['C:\\Desktop\\song.mp3', 'media'],
        ['C:\\Desktop\\backup.7z', 'archives'],
        ['C:\\Desktop\\mystery.xyz', 'others'],
        ['C:\\Desktop\\no-extension', 'others'],
    ])('%s → %s', (path, expected) => {
        expect(categorize(icon(path), dirs)).toBe(expected);
    });

    it('treats dot-prefixed names without a real extension as others', () => {
        expect(categorize(icon('C:\\Desktop\\.gitignore'), new Set())).toBe('others');
    });
});

describe('organizeConfig', () => {
    it('creates one cell per non-empty category, in order, without overlap', () => {
        const config = cfg({
            free_icons: [
                icon('C:\\D\\app.exe'),
                icon('C:\\D\\doc.pdf'),
                icon('C:\\D\\pic.png'),
            ],
        });
        const result = organizeConfig(config, new Set(), VIEWPORT, TITLES);
        expect(result.free_icons).toHaveLength(0);
        expect(result.cells.map((c) => c.title)).toEqual(['应用', '文档', '图片']);
        // Cells flow left-to-right without overlapping
        const xs = result.cells.map((c) => c.rect.x);
        expect(new Set(xs).size).toBe(3);
        expect(xs[0]!).toBeLessThan(xs[1]!);
        expect(xs[1]!).toBeLessThan(xs[2]!);
    });

    it('merges into an existing cell with the same title on repeat organize', () => {
        const existing = cell('应用', [icon('C:\\D\\old.exe')]);
        const config = cfg({ cells: [existing], free_icons: [icon('C:\\D\\new.exe')] });
        const result = organizeConfig(config, new Set(), VIEWPORT, TITLES);
        expect(result.cells).toHaveLength(1);
        expect(result.cells[0]!.icons.map((i) => i.path)).toEqual(['C:\\D\\old.exe', 'C:\\D\\new.exe']);
        // Merged cell keeps its position
        expect(result.cells[0]!.rect).toEqual(existing.rect);
    });

    it('leaves user cells untouched and returns same config when nothing to organize', () => {
        const config = cfg({ cells: [cell('My Stuff', [icon('C:\\D\\keep.txt')])] });
        expect(organizeConfig(config, new Set(), VIEWPORT, TITLES)).toBe(config);
    });

    it('uses the scan to classify folders (paths have no extension marker)', () => {
        const config = cfg({ free_icons: [icon('C:\\D\\Projects'), icon('C:\\D\\Notes.txt')] });
        const result = organizeConfig(config, new Set(['c:\\d\\projects']), VIEWPORT, TITLES);
        expect(result.cells.map((c) => c.title)).toEqual(['文件夹', '文档']);
    });

    it('wraps cells to the next row at the viewport edge', () => {
        const config = cfg({
            free_icons: [
                icon('C:\\D\\a.exe'), icon('C:\\D\\b.pdf'), icon('C:\\D\\c.png'),
                icon('C:\\D\\d.mp4'), icon('C:\\D\\e.zip'),
            ],
        });
        // Narrow viewport: only 2 cells per row
        const result = organizeConfig(config, new Set(), { width: 800, height: 1080 }, TITLES);
        const rows = new Set(result.cells.map((c) => c.rect.y));
        expect(rows.size).toBeGreaterThan(1);
        // No two cells share a position
        const positions = result.cells.map((c) => `${c.rect.x},${c.rect.y}`);
        expect(new Set(positions).size).toBe(positions.length);
    });

    it('sizes cells by icon count', () => {
        const many = Array.from({ length: 12 }, (_, n) => icon(`C:\\D\\f${n}.png`));
        const result = organizeConfig(cfg({ free_icons: many }), new Set(), VIEWPORT, TITLES);
        const single = organizeConfig(cfg({ free_icons: [icon('C:\\D\\one.png')] }), new Set(), VIEWPORT, TITLES);
        expect(result.cells[0]!.rect.height).toBeGreaterThan(single.cells[0]!.rect.height);
    });
});
