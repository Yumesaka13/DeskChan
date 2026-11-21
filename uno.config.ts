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
});
