import type { APIRoute } from 'astro';
import { getDevicesWithFirmwares, siteStats } from '@/lib/catalog';

// Catalog counts, small enough for README badges (shields.io dynamic JSON) to poll.
export const GET: APIRoute = async () => {
  const stats = siteStats(await getDevicesWithFirmwares());
  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
