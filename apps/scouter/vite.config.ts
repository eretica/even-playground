import { defineConfig } from 'vite'

// VITE_HMR_HOST に LAN IP を入れると実機の HMR が localhost 解決で落ちなくなる
const hmrHost = process.env.VITE_HMR_HOST

export default defineConfig({
  server: {
    host: true,
    port: 5180,
    ...(hmrHost ? { hmr: { host: hmrHost } } : {}),
    // 開発中はプロキシを同一オリジン(/api)で叩く → app.json の whitelist や CORS に依存しない
    proxy: {
      '/api': {
        target: process.env.PROXY_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
  build: { target: 'esnext' },
})
