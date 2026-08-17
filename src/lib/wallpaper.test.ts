import { describe, expect, it } from 'vitest';
import {
    adaptWallpaperTint,
    blendWithWhite,
    hexToRgba,
    mixHexColors,
    pickReadableTextColor,
    softenTint,
} from './wallpaper';

describe('wallpaper tint helpers', () => {
    it('mixes a wallpaper color with white to keep cells readable', () => {
        expect(mixHexColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    });

    it('keeps alpha blending predictable for cell backgrounds', () => {
        expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    });

    it('brightens dark wallpaper tints without overwhelming the cell', () => {
        expect(blendWithWhite('#1a1a1a', 0.22)).toBe('#4c4c4c');
    });

    it('softens dark wallpaper tints for less glare while keeping contrast', () => {
        expect(softenTint('#1a1a1a')).toBe('#4c4c4c');
    });

    it('chooses a contrasting foreground color for the wallpaper tint', () => {
        expect(pickReadableTextColor('#1a1a1a')).toBe('#f8fafc');
        expect(pickReadableTextColor('#f4f4f4')).toBe('#111827');
    });

    it('uses darker tinting in dark mode so the UI stays balanced', () => {
        expect(adaptWallpaperTint('#e8e8e8', 'dark')).toBe('#b1b3b7');
        expect(adaptWallpaperTint('#1a1a1a', 'dark')).toBe('#16191f');
    });
});
