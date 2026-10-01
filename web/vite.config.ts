import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// base './' so the built files can be served from any path (a file share or a static host).
//
// Live mode (see README, "Live mode"): with VITE_API_BASE=/api the app calls the real Claims API. The API has no CORS, so the
// dev and preview servers proxy /api to DEMO_API_TARGET (default http://127.0.0.1:8080) with the /api prefix stripped.
// With VITE_API_BASE unset nothing calls /api and the app is the mock.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = process.env.DEMO_API_TARGET || env.DEMO_API_TARGET || 'http://127.0.0.1:8080'
  const proxy = { '/api': { target, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/api/, '') } }
  return {
    base: './',
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})
