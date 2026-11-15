import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const server = process.env.SERVER_URL ?? 'http://127.0.0.1:4000'

export default defineConfig({
  plugins: [react()],
  // Two copies of Yjs in one page break document sync, so force a single one.
  resolve: { dedupe: ['yjs'] },
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
})
