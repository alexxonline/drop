import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

const target = 'http://localhost:3000'
// Vite treats a plain key as a string prefix, so '/s' would also swallow
// '/src/main.tsx'. A '^' key is a RegExp: match whole path segments only.
const proxied = ['/api', '/auth', '/f', '/s', '/health'].map((p) => `^${p}(/|\\?|$)`)

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    strictPort: true,
    // In dev both origins collapse onto the Vite host, so content routes are
    // proxied through too. Production serves them from CONTENT_ORIGIN instead.
    proxy: Object.fromEntries(proxied.map((path) => [path, { target, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
