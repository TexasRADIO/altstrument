import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { deviceSchema, firmwareBaseSchema, manufacturerSchema, refineFirmware } from './content/schema';
import { withWorkshopComputerCards } from './loaders/workshop-computer';

/**
 * devices/<device-slug>.yaml           -> id "<device-slug>"
 * firmwares/<device-slug>/<fw>.yaml    -> id "<device-slug>/<fw>"
 *
 * The firmwares collection also pulls the Music Thing Workshop Computer
 * program cards from the upstream repo at build time (see src/loaders).
 */
const devices = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/devices' }),
  schema: deviceSchema,
});

const firmwares = defineCollection({
  loader: withWorkshopComputerCards(
    glob({ pattern: '*/*.yaml', base: './src/content/firmwares' }),
  ),
  schema: refineFirmware(
    firmwareBaseSchema.extend({
      device: reference('devices'),
    }),
  ),
});

/** manufacturers/<slug>.yaml -> id "<slug>" (slug = slugify(name), see src/lib/slug.ts) */
const manufacturers = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/manufacturers' }),
  schema: manufacturerSchema,
});

export const collections = { devices, firmwares, manufacturers };
