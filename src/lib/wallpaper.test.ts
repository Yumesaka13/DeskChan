import { describe, expect, it } from 'vitest';
import { hexToRgba, mixHexColors, relativeLuminance, wallpaperPalette } from './wallpaper';

describe('wallpaper tint', () => {
    it('keeps alpha blending predictable for cell backgrounds', () => {
        expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    });

    it('keeps foregrounds readable over bright and dark wallpapers at the default opacity', () => {
        for (const theme of ['light', 'dark'] as const) {
            for (const wallpaper of ['#000000', '#ffff00', '#ff0000', '#ffffff']) {
                const palette = wallpaperPalette(wallpaper, theme, 0.01);
                const surface = mixHexColors(wallpaper, palette.surface, 0.85);
                const header = mixHexColors(surface, palette.header, 0.85 * 0.22);
                for (const background of [surface, header]) {
                    const contrast = [background, palette.foreground]
                        .map(relativeLuminance)
                        .sort((a, b) => a - b);
                    expect((contrast[1] + 0.05) / (contrast[0] + 0.05)).toBeGreaterThan(4.5);
                }
            }
        }
    });

    it('keeps the wallpaper hue visible in the header and accent', () => {
        const warm = wallpaperPalette('#e36738', 'dark', 0.01);
        const cool = wallpaperPalette('#3867e3', 'dark', 0.01);
        expect(warm.accent).not.toBe(cool.accent);
        expect(warm.header).not.toBe(warm.surface);
    });
});
