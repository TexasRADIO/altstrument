---
name: discover
description: Find custom firmware projects and devices missing from the altstrument catalog, research them, and draft device and firmware YAML for the maintainer to review. Use when asked to look for new firmware, new devices, or what the catalog is missing.
argument-hint: "[device slug, project URL, or topic to focus on]"
---

# /discover

You are adding entries to a hand-maintained catalog. The rules of the catalog live in `README.md` (Scope, Policy) and `CONTRIBUTING.md` (templates, field values, licenses, rules of evidence, what is not accepted). Read both before writing anything. They win over anything in this file.

You write files and run the validator. You never commit, push, open PRs, or stage changes. The maintainer reviews the working tree.

## 1. Gather candidates

First make sure the branch is up to date with `main` (in a worktree, use the app's sync; otherwise `git fetch` and merge). The dedupe reads the catalog on disk, so a stale branch re-creates entries that already landed upstream.

Then run the gather script from the repository root:

```sh
pnpm discover:candidates --since-days 14
```

- First run in a while, or the catalog looks stale: use `--since-days 30`.
- `$ARGUMENTS` is a URL: skip the script. That URL is the only candidate. If it is already in the catalog (grep `src/content` for the repository and the project name), treat it as an update check on that entry rather than a new one.
- `$ARGUMENTS` is a device slug or a topic word: run the script with `--filter "<argument>"`, and also treat the argument itself as a research lead (search the web for `"<device name>" custom firmware`).
- A full run takes a few minutes: the reddit feeds allow about one request a minute, and the per-device GitHub searches take another four. Pass `--no-device-queries` for a quicker pass; the generic searches catch most new projects.

The script prints a markdown report and writes `discover-candidates.json`. It already drops repositories that the catalog links to and anything under `ignore` in `.claude/skills/discover/config.yaml`. News items are not dropped when they mention a catalog entry; the "Mentions catalog" column tells you which one.

## 2. Triage

Go through every row. For each one decide: new firmware, new device, update to an existing entry, or reject.

In scope (README "Scope"): firmware that replaces or modifies what runs on a music device, and host-side tools that support it (editors, flashers, emulators, SDKs). A device is listed even when no custom firmware exists, with a note saying why.

Reject when any of these hold. Record the reason.
- Official manufacturer firmware, unless the device's existing entries already catalog official firmware the same way (Noise Engineering Legio and Versio do this; follow the device directory's precedent).
- Redistributed or mirrored stock firmware, or anything that links to it. Exception: a file the manufacturer licenses for redistribution, matched by hash. Today that is only M-VAVE's FM-1 V15 image (`sdk/firmware/FM-1_015.fwsc` in `m-vave/fm1_open`, Apache-2.0, git blob `ce49cc1595b67347c68a3ac7463017f9fa8c19dd`, 699,956 bytes). Compare a bundled copy's blob SHA from the repo tree API. SMK-37 stock packages and any other M-VAVE file are not covered.
- No working source repository and no working homepage.
- Not music hardware: desktop software, plugins, general MCU projects, keyboards in the computer sense, lighting.
- Pure news about a stock OS update with no third-party code.
- A GitHub search hit that is a fork, a template, an archived toy, or clearly unrelated to the device named in the query.

A news item that mentions a catalog entry is usually a new version of that entry. Open the firmware file, check `versions[]`, and if the release is real and confirmed, add the version at the top of the list following the existing style. That counts as an update, not a new entry.

## 3. Research each kept candidate

Collect evidence before writing. Keep the URLs; they go into the file and the report.

- Project page and README: what it does, which device, which stock firmware it needs, how it installs, brick risk.
- License: open the `LICENSE` file or the license statement and map it to the exact SPDX id in the `LICENSES` list in `src/content/schema.ts`. Follow CONTRIBUTING "Choosing a license" to the letter, including `proprietary` and `unspecified`, and quote vague statements in `license_notes`.
- Versions: GitHub releases with their dates and release URLs. Tags without a release page: the tag as `version`, `https://github.com/<owner>/<repo>/tree/<tag>` as `url`, the tagged commit's date as `date`, and `notes: Git tag; no GitHub release page.` (see `m-vave-fm-1/modular-1.yaml`). No tags at all: the latest commit as `main @ <sha7>` (or `master @ ...`, matching the default branch) with `notes: No tagged releases; this is the latest commit.` and the commit URL. A release page, changelog or commit confirms a date; nothing else does. Omit `date` otherwise.
- Authors with profile links. When the same person already appears elsewhere in `src/content`, reuse that name form. Status per CONTRIBUTING's table, judged from commit and release dates.
- Demo video: only a YouTube link that the project's own README or homepage links to, with `first_party: true` and `found_via`. A channel link is not a video. Otherwise no video. An `image` only when there is no video: prefer one the README or homepage itself displays, use the direct https file URL, and open it so the alt text describes what is actually shown.
- Device: does `src/content/devices/<manufacturer>-<device>.yaml` exist? Look at `related` devices too; some firmware targets a family. Check `src/content/manufacturers/` for the manufacturer's exact display name and reuse it.
- Install and risk: `distribution`, `requires_stock`, `install_notes` and `brick_risk` from the project's own install docs. A fork or derivative of a firmware already on the same device inherits that entry's `brick_risk` unless the project documents otherwise.
- Long READMEs get truncated in tool output. Save them to a file and read in pieces rather than skimming the first screen.

Dedupe once more by hand: grep `src/content` for the repository owner, the project name and the homepage host. The script catches repositories, not renamed projects.

## 4. Write the entries

- Device first when it does not exist: `src/content/devices/<slug>.yaml` from the CONTRIBUTING device template. Slug is `manufacturer-device` in kebab-case. Fill `description` with two to four factual sentences, `platform` and `stock_firmware` when known, `links.manufacturer` and a community link or two.
- Then `src/content/firmwares/<device-slug>/<firmware-slug>.yaml` from the firmware template. Keep the field order of the template and of neighbouring files in the same directory.
- Prose is yours. Never paste text from the README, release notes, forum posts or other catalogs. Plain factual sentences, no marketing language.
- Tags: lowercase kebab-case words that neighbouring entries already use where possible (`grep -rh '^tags:' src/content/firmwares | sort | uniq -c | sort -rn | head -40`).
- Run the validator after each file, fix every error and look at every warning:

```sh
ALTSTRUMENT_SKIP_REMOTE=1 pnpm validate
```

Once every file is written, run it once more without `ALTSTRUMENT_SKIP_REMOTE` if you added a `video` or `image`, so the remote media checks run.

## 5. Record rejections

Append each rejected candidate to `ignore` in `.claude/skills/discover/config.yaml`:

```yaml
  - url: https://github.com/owner/repo
    reason: fork of a catalogued project with no changes
    date: 2026-10-14
```

Use the repository URL for GitHub candidates and the article or project URL otherwise. Do not record news items that were merely uninteresting this week; only things that should never come back. Keep `ignore: []` syntax valid when adding the first item (replace `[]` with a list).

## 6. Report and stop

End with a short report:

- Files written, each as a clickable path, one line each saying what the entry is and the evidence link for its version.
- Updates to existing entries, with the file path and the version added.
- Rejected candidates with their one-line reasons.
- Open questions the maintainer must settle, for example an unclear license, a device that might belong to an existing family, or a video whose first-party status is uncertain.
- The validator's final summary line.

Leave the working tree uncommitted. Do not run `git add`, `git commit`, `git push`, `gh pr create`, or `git stash`.

## Running elsewhere

Headless (`claude -p "/discover"` from a launchd or cron job) or as a scheduled cloud routine, nobody is at the keyboard to review the working tree. In those modes, and only those modes, create a branch named `discover/<YYYY-MM-DD>` from `main` before writing, commit the files with a message per entry, push the branch and open a draft pull request whose body is the report above. Everything else in this skill is unchanged. An interactive session never does this.
