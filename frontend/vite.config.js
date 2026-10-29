import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/auth': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3000',
        // Keep the browser's Host header so the backend derives the OAuth
        // callback as http://localhost:5173/auth/google/callback.
        changeOrigin: false,
      },
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3000',
        changeOrigin: false,
      },
      '/csrf-token': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
})
