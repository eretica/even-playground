import { defineConfig } from 'vite'

// VITE_HMR_HOST に LAN IP を入れると実機の HMR が localhost 解決で落ちなくなる
const hmrHost = process.env.VITE_HMR_HOST

export default defineConfig({
  server: {
    host: true,
    port: 5180,
    ...(hmrHost ? { hmr: { host: hmrHost } } : {}),
  },
  build: { target: 'esnext' },
})
