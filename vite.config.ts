import { sites } from '@openai/sites-vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sites(),
    (await import('@cloudflare/vite-plugin')).cloudflare({
      viteEnvironment: { name: 'server' },
    }),
  ],
});
