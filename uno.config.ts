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
        primary: '#6366f1',   // Indigo
        secondary: '#a855f7', // Purple
      },
    },
  },
  shortcuts: {
    'glass-panel': 'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md border border-white/20 dark:border-gray-700/30 rounded-xl shadow-lg',
    'cell-empty': 'border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg',
  },
});
