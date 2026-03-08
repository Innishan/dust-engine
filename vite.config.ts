import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 3000,
    strictPort: true,
    allowedHosts: [
      'dust-engine.onrender.com',
      '.onrender.com',  // Allows all render subdomains
      'localhost',
      '.dustengine.xyz'  // For when you connect your custom domain
    ]
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
  }
})
