/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import UnoCSS from 'unocss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [UnoCSS(), solid()],
  test: {
    // Pure-logic tests only - vite-plugin-solid would otherwise default to
    // jsdom, which is not installed. Switch when component tests appear.
    environment: 'node',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@bindings': path.resolve(__dirname, 'src-tauri/bindings'),
    },
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell vite to ignore watching src-tauri
      ignored: ['**/src-tauri/**'],
    },
  },
});
