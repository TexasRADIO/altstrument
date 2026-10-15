/**
 * Catalog helpers. Pages stay thin: all grouping, sorting and URL logic is here.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  STATUSES,
  type Category,
  type ManufacturerLogo,
  type Status,
  type Version,
} from '@/content/schema';

type DeviceEntry = CollectionEntry<'devices'>;
type FirmwareEntry = CollectionEntry<'firmwares'>;
type ManufacturerEntry = CollectionEntry<'manufacturers'>;

export interface FirmwareItem {
  /** "<device-slug>/<fw-slug>" */
  id: string;
  slug: string;
  deviceId: string;
  url: string;
  data: FirmwareEntry['data'];
  /** Newest first, undated last. */
  versions: Version[];
}

export interface DeviceItem {
  id: string;
  url: string;
  data: DeviceEntry['data'];
  manufacturerSlug: string;
  /**
   * The manufacturer's logo, resolved only when the device has no `image`
   * (the fallback visual). Pages and cards read this instead of re-querying.
   */
  logo?: ManufacturerLogo;
  /** Sorted: kind firmware before tool, then by status, then name. */
  firmwares: FirmwareItem[];
}

export interface Manufacturer {
  slug: string;
  name: string;
  url: string;
  website?: string;
  /** From the manufacturers collection; shown on the manufacturer page whether or not devices have images. */
  logo?: ManufacturerLogo;
  devices: DeviceItem[];
  firmwareCount: number;
}

export interface CategoryGroup {
  category: Category;
  label: string;
  devices: DeviceItem[];
}

export interface RecentVersion {
  date: Date;
  version: Version;
  firmware: FirmwareItem;
  device: DeviceItem;
}

/** kebab-case of a name; used for manufacturer slugs everywhere. */
import { slugify } from './slug';
export { slugify };

const STATUS_ORDER: Status[] = ['active', 'maintained', 'dormant', 'announced', 'unknown', 'archived'];

export function statusRank(status: Status): number {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUSES.length : i;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

export function compareFirmwares(a: FirmwareItem, b: FirmwareItem): number {
  const kind = Number(a.data.kind === 'tool') - Number(b.data.kind === 'tool');
  if (kind) return kind;
  const status = statusRank(a.data.status) - statusRank(b.data.status);
  if (status) return status;
  return compareText(a.data.name, b.data.name);
}

export function compareDevices(a: DeviceItem, b: DeviceItem): number {
  return compareText(a.data.manufacturer, b.data.manufacturer) || compareText(a.data.name, b.data.name);
}

/** Newest date first; undated versions last in their original order. */
export function sortVersions(versions: Version[]): Version[] {
  return [...versions].sort((a, b) => {
    if (a.date && b.date) return b.date.getTime() - a.date.getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

export function latestVersion(fw: FirmwareItem): Version | undefined {
  return fw.versions[0];
}

export function manufacturerUrl(name: string): string {
  return `/manufacturers/${slugify(name)}`;
}

/** All manufacturer entries keyed by id (= slugify(name)). */
export async function getManufacturerEntries(): Promise<Map<string, ManufacturerEntry>> {
  const entries = await getCollection('manufacturers');
  return new Map(entries.map((e) => [e.id, e]));
}

/** Manufacturer entry for a device's `manufacturer` string, keyed by slugify(name). */
export async function manufacturerFor(name: string): Promise<{ id: string; data: ManufacturerEntry['data'] } | undefined> {
  const entry = (await getManufacturerEntries()).get(slugify(name));
  return entry && { id: entry.id, data: entry.data };
}

export async function getDevicesWithFirmwares(): Promise<DeviceItem[]> {
  const [devices, firmwares, manufacturers] = await Promise.all([
    getCollection('devices'),
    getCollection('firmwares'),
    getManufacturerEntries(),
  ]);

  const byDevice = new Map<string, FirmwareItem[]>();
  for (const fw of firmwares) {
    const deviceId = fw.data.device.id;
    const slug = fw.id.split('/').pop() as string;
    const item: FirmwareItem = {
      id: fw.id,
      slug,
      deviceId,
      url: `/firmware/${deviceId}/${slug}`,
      data: fw.data,
      versions: sortVersions(fw.data.versions),
    };
    const list = byDevice.get(deviceId) ?? [];
    list.push(item);
    byDevice.set(deviceId, list);
  }

  return devices
    .map((d): DeviceItem => {
      const manufacturerSlug = slugify(d.data.manufacturer);
      const logo = d.data.image ? undefined : manufacturers.get(manufacturerSlug)?.data.logo;
      return {
        id: d.id,
        url: `/devices/${d.id}`,
        data: d.data,
        manufacturerSlug,
        ...(logo ? { logo } : {}),
        firmwares: (byDevice.get(d.id) ?? []).sort(compareFirmwares),
      };
    })
    .sort(compareDevices);
}

export function firmwaresForDevice(devices: DeviceItem[], deviceId: string): FirmwareItem[] {
  return devices.find((d) => d.id === deviceId)?.firmwares ?? [];
}

export function groupByCategory(devices: DeviceItem[]): CategoryGroup[] {
  return CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    devices: devices.filter((d) => d.data.category === category).sort(compareDevices),
  })).filter((g) => g.devices.length > 0);
}

export function groupByManufacturer(
  devices: DeviceItem[],
  manufacturers: Map<string, ManufacturerEntry> = new Map(),
): Manufacturer[] {
  const map = new Map<string, Manufacturer>();
  for (const d of devices) {
    let m = map.get(d.manufacturerSlug);
    if (!m) {
      m = {
        slug: d.manufacturerSlug,
        name: d.data.manufacturer,
        url: `/manufacturers/${d.manufacturerSlug}`,
        website: manufacturers.get(d.manufacturerSlug)?.data.website,
        logo: manufacturers.get(d.manufacturerSlug)?.data.logo,
        devices: [],
        firmwareCount: 0,
      };
      map.set(d.manufacturerSlug, m);
    }
    m.devices.push(d);
    m.firmwareCount += d.firmwares.length;
  }
  return [...map.values()]
    .map((m) => ({ ...m, devices: m.devices.sort((a, b) => compareText(a.data.name, b.data.name)) }))
    .sort((a, b) => compareText(a.name, b.name));
}

/** Newest dated version across a device's firmwares, if any. */
export function latestUpdate(device: DeviceItem): Date | undefined {
  let best: Date | undefined;
  for (const fw of device.firmwares) {
    const d = fw.versions.find((v) => v.date)?.date;
    if (d && (!best || d.getTime() > best.getTime())) best = d;
  }
  return best;
}

/** Newest update across several devices, if any. */
export function latestUpdateOf(devices: DeviceItem[]): Date | undefined {
  let best: Date | undefined;
  for (const d of devices) {
    const u = latestUpdate(d);
    if (u && (!best || u.getTime() > best.getTime())) best = u;
  }
  return best;
}

export function firmwareTotal(devices: DeviceItem[]): number {
  return devices.reduce((n, d) => n + d.firmwares.length, 0);
}

/** Most firmware entries first; ties by name. Matches the "popularity" sort on the index. */
export function compareByPopularity(a: DeviceItem, b: DeviceItem): number {
  return b.firmwares.length - a.firmwares.length || compareText(a.data.name, b.data.name);
}

/**
 * The most recent dated versions across all firmwares, newest first.
 * `onePerFirmware` keeps only each firmware's newest dated version, so one
 * busy release day can't fill a short list.
 */
export function recentVersions(
  devices: DeviceItem[],
  limit = 50,
  { onePerFirmware = false }: { onePerFirmware?: boolean } = {},
): RecentVersion[] {
  const all: RecentVersion[] = [];
  for (const device of devices) {
    for (const firmware of device.firmwares) {
      // versions are sorted newest first, undated last
      for (const version of firmware.versions) {
        if (!version.date) continue;
        all.push({ date: version.date, version, firmware, device });
        if (onePerFirmware) break;
      }
    }
  }
  return all
    .sort(
      (a, b) =>
        b.date.getTime() - a.date.getTime() ||
        compareText(a.firmware.data.name, b.firmware.data.name) ||
        compareText(a.version.version, b.version.version),
    )
    .slice(0, limit);
}

export function siteStats(devices: DeviceItem[]) {
  return {
    devices: devices.length,
    // Counted by kind: host-side tools (editors, flashers, SDKs) are not firmwares.
    firmwares: devices.reduce((n, d) => n + d.firmwares.filter((f) => f.data.kind === 'firmware').length, 0),
    tools: devices.reduce((n, d) => n + d.firmwares.filter((f) => f.data.kind === 'tool').length, 0),
    manufacturers: new Set(devices.map((d) => d.manufacturerSlug)).size,
  };
}

/** YYYY-MM-DD (UTC), the form dates are authored in. */
export function isoDate(date?: Date): string | undefined {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

export function versionAnchor(version: string): string {
  return `v-${slugify(version) || 'x'}`;
}

/**
 * GitHub's editor for a raw.githubusercontent.com file URL (how synced entries record
 * generated_from). Other URLs are returned unchanged.
 */
export function githubEditUrl(url: string): string {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/edit/${m[3]}/${m[4]}` : url;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Split free text into paragraphs on blank lines. */
export function paragraphs(text?: string): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
