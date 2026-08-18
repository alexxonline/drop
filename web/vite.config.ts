import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

const target = 'http://localhost:3000'
const proxied = ['/api', '/auth', '/f', '/s', '/health']

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
