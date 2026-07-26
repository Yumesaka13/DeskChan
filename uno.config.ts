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
    // 8px corners, and only a whisper of elevation
    'glass-panel': 'bg-white/75 dark:bg-[#2c2c2c]/75 backdrop-blur-xl border border-black/8 dark:border-white/9 rounded-lg shadow-sm',
    'cell-empty': 'border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg',
    // WinUI control stroke, shared by every button so borders always match:
    // hairline rim with a slightly darker BOTTOM edge in light theme and a
    // slightly lighter TOP edge in dark theme (the Fluent depth cue)
    'fluent-stroke': 'border border-black/6 border-b-black/16 dark:border-white/8 dark:border-t-white/12',
    // Fluent standard button (4px radius, subtle fill)
    'fluent-btn': 'fluent-stroke px-3 py-1.5 rounded text-sm bg-black/3 dark:bg-white/6 hover:bg-black/6 dark:hover:bg-white/10 active:bg-black/3 dark:active:bg-white/4 transition-colors',
    // Fluent accent (primary) button — same rim over the accent fill
    'fluent-btn-accent': 'fluent-stroke px-3 py-1.5 rounded text-sm text-white bg-brand-primary hover:bg-brand-primary/90 active:bg-brand-primary/80 transition-colors',
    // Fluent menu item: inset rounded hover fill like Win11 context menus
    // (containers add px-1 so w-full items stay inset)
    'fluent-menu-item': 'w-full rounded px-2.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/8 transition-colors duration-75',
    // Square icon-only button (Win11 caption-button style): fixed square,
    // centered glyph, subtle rounded hover fill
    'fluent-icon-btn': 'w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/8 transition-colors duration-75',
    // Win11 Mica surface: near-opaque tinted base with strong blur+saturate —
    // flyouts/menus read as a solid material, unlike the lighter acrylic cards
    'mica-panel': 'bg-[#f3f3f3]/90 dark:bg-[#202020]/90 backdrop-blur-2xl backdrop-saturate-150 border border-black/8 dark:border-white/9 rounded-lg shadow-lg',
  },
});
