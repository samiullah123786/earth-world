import { sites } from '@openai/sites-vite-plugin';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [sites()];
  if (command === 'build' && mode !== 'test') {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare({ viteEnvironment: { name: 'server' } }));
  }
  return { plugins };
});
