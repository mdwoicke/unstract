import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * Content script build: IIFE format so Chrome can load it in classic mode.
 * All dependencies (React, etc.) are inlined into a single content.js file.
 * Run AFTER the main vite build (outDir dist, emptyOutDir false).
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    // Vite lib mode doesn't strip process.env automatically for IIFE
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,  // append to existing dist from main build
    target: 'es2020',
    lib: {
      entry: resolve(__dirname, 'src/content/content.ts'),
      formats: ['iife'],
      name: 'UnstractContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        // Inline all dynamic imports so there are no import() calls
        inlineDynamicImports: true,
        entryFileNames: 'content.js',
      },
    },
    minify: false,
  },
})
