import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/, so assets need that prefix there.
  // Local dev and any root-domain host stay on '/'.
  base: process.env.GITHUB_PAGES ? '/asvanta-demo/' : '/',
  plugins: [react()],
  // Emit \uXXXX escapes instead of raw UTF-8, so the bundle renders correctly
  // even when the host serves the page without a charset declaration.
  esbuild: { charset: 'ascii' },
  server: { port: 5173, open: true },
})
