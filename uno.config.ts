import { defineConfig, presetUno, presetIcons } from 'unocss';

export default defineConfig({
  presets: [
    presetUno(),
    presetIcons({
      scale: 1.2,
    }),
  ],
  // Allow extracting classes from SolidJS JSX
  content: {
    filesystem: ['src/**/*.{ts,tsx}'],
  },
  theme: {
    colors: {
      brand: {
        // Windows 11 accent (SystemAccentColor) + its dark-theme light shade
        primary: '#0067C0',
        secondary: '#4CC2FF',
      },
    },
  },
  shortcuts: {
    // Win11 Fluent acrylic card: translucent surface, hairline stroke,
    // 8px corners, and only a whisper of elevation.
    // border-solid is REQUIRED on non-button elements — the app ships no CSS
    // reset, so the UA default border-style:none would hide the hairline.
    'glass-panel': 'bg-white/75 dark:bg-[#2c2c2c]/75 backdrop-blur-xl border border-solid border-black/8 dark:border-white/10 rounded-lg shadow-md',
    'cell-empty': 'border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg',
    // Fluent standard button: ONE uniform hairline border color (flat) —
    // per-side shading read as mismatched borders at control size
    'fluent-btn': 'px-3 py-1.5 rounded text-sm border border-solid border-black/10 dark:border-white/12 bg-black/3 dark:bg-white/6 hover:bg-black/6 dark:hover:bg-white/10 active:bg-black/3 dark:active:bg-white/4 transition-colors',
    // Fluent accent (primary) button: borderless accent fill; the
    // transparent border keeps its box the same size as standard buttons
    'fluent-btn-accent': 'px-3 py-1.5 rounded text-sm border border-solid border-transparent text-white bg-brand-primary hover:bg-brand-primary/90 active:bg-brand-primary/80 transition-colors',
    // Fluent menu item: inset rounded hover fill like Win11 context menus
    // (containers add px-1 so w-full items stay inset)
    'fluent-menu-item': 'w-full rounded px-2.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/8 transition-colors duration-75',
    // Square icon-only button (Win11 caption-button style): fixed square,
    // centered glyph, subtle rounded hover fill
    'fluent-icon-btn': 'w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/8 transition-colors duration-75',
    // Win11 Mica surface: near-opaque tinted base with strong blur+saturate —
    // flyouts/menus read as a solid material, unlike the lighter acrylic cards
    'mica-panel': 'bg-[#f3f3f3]/90 dark:bg-[#202020]/90 backdrop-blur-2xl backdrop-saturate-150 border border-solid border-black/8 dark:border-white/10 rounded-lg shadow-lg',
  },
});
