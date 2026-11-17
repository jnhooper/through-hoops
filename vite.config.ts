import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  // Keep Rust compiler errors visible in the terminal instead of clearing them.
  clearScreen: false,
  plugins: [
    react(),
    tailwindcss(),
  ],
server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    // Rust rebuilds write under src-tauri; don't reload the frontend for them.
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
  },
})
