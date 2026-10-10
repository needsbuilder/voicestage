import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI lives in ui/ and is built into dist/ui, next to the compiled server.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: { host: '127.0.0.1' },
});
