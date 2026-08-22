import { sites } from '@openai/sites-vite-plugin';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig(async ({ mode }) => {
  const plugins: PluginOption[] = [sites()];
  if (mode !== 'test') {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare({ viteEnvironment: { name: 'server' } }));
  }
  return { plugins };
});
