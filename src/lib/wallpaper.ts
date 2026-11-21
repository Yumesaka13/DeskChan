export function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const normalized = hex.replace('#', '').trim();
    const safe = normalized.length === 3
        ? normalized.split('').map((ch) => ch + ch).join('')
        : normalized;
    const value = Number.parseInt(safe, 16);
    if (!Number.isFinite(value) || safe.length !== 6) {
        return { r: 0, g: 0, b: 0 };
    }
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}
export function rgbToHex(r: number, g: number, b: number): string {
    const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function mixHexColors(left: string, right: string, weight: number): string {
    const leftRgb = hexToRgb(left);
    const rightRgb = hexToRgb(right);
    const ratio = Math.min(1, Math.max(0, weight));
    const r = leftRgb.r + (rightRgb.r - leftRgb.r) * ratio;
    const g = leftRgb.g + (rightRgb.g - leftRgb.g) * ratio;
    const b = leftRgb.b + (rightRgb.b - leftRgb.b) * ratio;
    return rgbToHex(r, g, b);
}

export function hexToRgba(hex: string, alpha: number): string {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

export function wallpaperPalette(seed: string, theme: 'light' | 'dark', overlay: number) {
    const dark = theme === 'dark';
    const neutral = dark ? '#14171d' : '#fbfcfe';
    // Treat the sampled hue as a tint on top of a theme surface. Keeping
    // most of the neutral prevents bright wallpapers from washing out dark
    // mode and very dark wallpapers from muddying light mode.
    const tone = (strength: number) =>
        mixHexColors(mixHexColors(neutral, seed, strength), '#ffffff', overlay * 0.28);
    return {
        surface: tone(dark ? 0.20 : 0.13),
        header: tone(dark ? 0.30 : 0.22),
        foreground: dark ? '#f4f6fb' : '#162030',
        muted: dark ? '#d6dee9' : '#3e4b5d',
        border: mixHexColors(dark ? '#6b7280' : '#9da8b8', seed, 0.25),
        accent: mixHexColors(dark ? '#e2e8f0' : '#334155', seed, 0.40),
    };
}

export function relativeLuminance(hex: string): number {
    const { r, g, b } = hexToRgb(hex);
    const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
