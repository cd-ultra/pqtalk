import { defineConfig } from 'vite';
export default defineConfig({
  base: './', // works from any static host sub-path (GitHub Pages, Cloudflare Pages, Netlify)
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
