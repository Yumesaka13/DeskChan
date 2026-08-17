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

export function blendWithWhite(hex: string, amount = 0.18): string {
    return mixHexColors(hex, '#ffffff', amount);
}

export function softenTint(hex: string, amount = 0.22): string {
    return blendWithWhite(hex, amount);
}

export function adaptWallpaperTint(hex: string, theme: 'light' | 'dark', amount = 0.22): string {
    const kind = theme === 'dark' ? '#111827' : '#ffffff';
    const lightness = relativeLuminance(hex);
    const ratio = theme === 'dark'
        ? Math.min(0.42, Math.max(0.18, amount + (1 - lightness) * 0.18))
        : Math.min(0.32, Math.max(0.12, amount));
    return mixHexColors(hex, kind, ratio);
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

export function pickReadableTextColor(hex: string, lightText = '#f8fafc', darkText = '#111827'): string {
    return relativeLuminance(hex) > 0.48 ? darkText : lightText;
}
