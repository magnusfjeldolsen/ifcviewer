import { defineConfig } from 'vite';

export default defineConfig({
  // Set base path for GitHub Pages — update 'ifcviewer' to match your repo name
  base: '/ifcviewer/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    open: true,
  },
});
