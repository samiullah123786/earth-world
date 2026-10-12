import { workshopProxy } from '../shared/ownerProxy';

export default {
  async fetch(request: Request, env: { EARTH_KERNEL_URL?: string }) {
    if (new URL(request.url).pathname.startsWith('/api/workshop/')) return workshopProxy(request, env.EARTH_KERNEL_URL);
    return new Response('Not found', { status: 404 });
  },
};
