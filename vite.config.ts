import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves a project repository at https://<user>.github.io/<repo>/
// The workflow sets BASE_PATH=/<repo>/ automatically. Locally the app runs at "/".
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
