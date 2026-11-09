import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { global: 'globalThis' },
  resolve: { alias: { buffer: 'buffer/' } },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '0.0.0.0', allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
