# Firmware World

Firmware World is a read-only directory of custom and third-party firmware for music hardware, including grooveboxes, synths, samplers, controllers, pedals, Eurorack modules and vintage gear. Each device has a page listing the firmware built for it, and each firmware entry records its authors, a source or homepage link, its license, version history and status. The site links to where firmware lives. It does not host firmware files.

## What is recorded

For each firmware:

- name, kind (firmware or host-side tool), and a one-sentence summary
- authors, with optional profile links
- source repository and/or homepage
- source status (open, patcher-only, binary-only, closed) and license, with license notes where needed
- distribution method and any stock firmware it requires
- install notes and a brick-risk flag
- version history, newest first
- maintenance status (active, maintained, dormant, archived, announced, unknown)

## Scope

Firmware that replaces or modifies what runs on a device, and host-side tools that support it (editors, flashers, emulators, SDKs). Devices are listed even when no custom firmware exists, with a note saying why.

## Policy

- Entries link to sources. Binaries are never hosted in this repository or on this site.
- Links to redistributed manufacturer firmware are not accepted.
- Flashing firmware is at your own risk and may void your warranty. Entries flagged `brick_risk` carry a documented risk of bricking the device; read their install notes before flashing.

## Repository layout

```
src/
  content/
    devices/                  one YAML file per device
    firmwares/
      <device-slug>/          one directory per device
        <firmware-slug>.yaml  one YAML file per firmware
    schema.ts                 Zod schemas and allowed values (the field reference)
  content.config.ts           Astro content collections
  pages/                      Astro pages
scripts/
  validate.ts                 catalog validator (runs before build and in CI)
```

## Local development

Requires Node 22 (the version CI uses) and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm dev        # local dev server
pnpm validate   # check every catalog YAML file against the schema
pnpm check      # Astro type check
pnpm build      # validates, then builds the static site
pnpm preview    # serve the built site
```

Building fetches the Music Thing Workshop Computer card entries from the upstream repository (see CONTRIBUTING.md, "Entries fetched at build time"). Set `FIRMWARE_WORLD_SKIP_REMOTE=1` to build offline from the cached data store.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a device or firmware, the field reference, and the pull request checklist.

## Licensing

- Code (including `src/` and `scripts/`) is MIT. See [LICENSE](LICENSE).
- Catalog data (the YAML files under `src/content/devices` and `src/content/firmwares`) is CC-BY-4.0. See [LICENSE-DATA](LICENSE-DATA).

Each firmware's own code is governed by the license recorded in its entry, not by this repository's licenses.

## Prior art and thanks

- [Lapin/awesome-music-gear-firmware](https://github.com/Lapin/awesome-music-gear-firmware)
- [aroum/fm1-custom-fw](https://github.com/aroum/fm1-custom-fw)
- [Maxhodges/noise-engineering-firmware-index](https://github.com/Maxhodges/noise-engineering-firmware-index)
- [Mutable Instruments third-party firmware](https://pichenettes.github.io/mutable-instruments-documentation/third_party_firmware/)

Hosting is set up separately.
