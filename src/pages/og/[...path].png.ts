import type { APIContext } from 'astro';
import { KIND_LABELS } from '@/lib/labels';
import { renderCard, type CardInput } from '@/lib/og';
import { getDevicesWithFirmwares, getManufacturerEntries, groupByManufacturer, plural, siteStats, type DeviceItem } from '@/lib/catalog';

// One card per HTML page, at /og/<page path>.png (the home page is /og/index.png).
// Base.astro derives the same path for og:image, so a new page type needs an entry here.
export async function getStaticPaths() {
  const [devices, entries] = await Promise.all([getDevicesWithFirmwares(), getManufacturerEntries()]);
  const stats = siteStats(devices);
  const card = (path: string, props: CardInput) => ({ params: { path }, props });
  const visualOf = (d: DeviceItem) => d.data.image?.src ?? d.logo?.src;
  const counts = (d: DeviceItem) => {
    const fw = d.firmwares.filter((f) => f.data.kind === 'firmware').length;
    const tools = d.firmwares.length - fw;
    return [fw > 0 && plural(fw, 'custom firmware'), tools > 0 && plural(tools, 'tool')].filter(Boolean).join(' and ');
  };

  return [
    card('index', {
      eyebrow: 'A directory for music hardware',
      title: 'Alternative firmware and tools for music hardware',
      summary: 'Custom firmware for synths, grooveboxes, samplers, controllers, pedals and Eurorack, with sources, licenses and version history.',
      footer: `${plural(stats.devices, 'device')} · ${plural(stats.firmwares, 'firmware')} · ${plural(stats.tools, 'tool')}`,
    }),
    card('about', {
      title: 'About',
      summary: 'What altstrument lists, what it does not, how to read the badges, and how to contribute.',
    }),
    card('recent', {
      title: 'Recent versions',
      summary: 'The 50 most recent dated firmware versions across the catalog.',
    }),
    ...devices.map((d) =>
      card(d.url.slice(1), {
        eyebrow: d.data.manufacturer,
        title: d.data.name,
        summary: d.data.tagline,
        visual: visualOf(d),
        footer: counts(d) || 'No custom firmware listed yet',
      }),
    ),
    ...devices.flatMap((d) =>
      d.firmwares.map((fw) =>
        card(fw.url.slice(1), {
          eyebrow: `${KIND_LABELS[fw.data.kind]} for ${d.data.name} · ${d.data.manufacturer}`,
          title: fw.data.name,
          summary: fw.data.summary,
          visual: visualOf(d),
          footer: `by ${fw.data.authors.map((a) => a.name).join(', ')}`,
        }),
      ),
    ),
    ...groupByManufacturer(devices, entries).map((m) =>
      card(m.url.slice(1), {
        eyebrow: 'Manufacturer',
        title: m.name,
        summary: `${plural(m.devices.length, 'device')}: ${m.devices.map((d) => d.data.name).join(', ')}.`,
        visual: m.logo?.src ?? m.devices.map(visualOf).find(Boolean),
        footer: plural(m.firmwareCount, 'listed firmware or tool', 'listed firmwares and tools'),
      }),
    ),
  ];
}

export async function GET({ props }: APIContext<CardInput>) {
  return new Response(await renderCard(props), { headers: { 'Content-Type': 'image/png' } });
}
