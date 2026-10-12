import { sites } from '@openai/sites-vite-plugin';
import { defineConfig, type PluginOption } from 'vite';
import { workshopProxy } from './shared/ownerProxy.ts';

const workshopApi: PluginOption = {
  name: 'workshop-owner-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/workshop/')) return next();
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) { res.statusCode = 413; res.end('{"ok":false,"why":"Request is too large."}'); return; }
          chunks.push(Buffer.from(chunk));
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        const request = new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method, headers, ...(size ? { body: Buffer.concat(chunks).toString() } : {}),
        });
        const response = await workshopProxy(request, process.env.EARTH_KERNEL_URL);
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(await response.text());
      } catch { res.statusCode = 503; res.end('{"ok":false,"why":"Workshop connection unavailable. Retry."}'); }
    });
  },
};

export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [sites(), workshopApi];
  if (command === 'build' && mode !== 'test') {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare({ viteEnvironment: { name: 'server' } }));
  }
  return {
    plugins,
    environments: {
      client: { build: { rollupOptions: { input: { world: 'index.html', workshop: 'workshop.html' } } } },
    },
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
