import { sites } from '@openai/sites-vite-plugin';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [sites()];
  if (command === 'build' && mode !== 'test') {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare({ viteEnvironment: { name: 'server' } }));
  }
  return {
    plugins,
    // Vitest's five-second default is a UNIT test budget, and most of this
    // suite is not unit tests: a Kernel test seeds an entire world, settles
    // citizens, runs the civic approval chain and lays expansion rings inside a
    // simulated Convex backend. Four of them have always taken between five and
    // twelve seconds, and were quietly failing the run for it - measured
    // identical before and after the work that surfaced them, so this is age,
    // not a regression. Sixty seconds clears the slowest real test five times
    // over, including under the CPU contention of fifty-five files in parallel,
    // while still failing a genuinely hung test rather than hanging forever.
    test: { testTimeout: 60_000, hookTimeout: 60_000 },
  };
});
