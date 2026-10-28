# Publishing checklist

Everything here is a public action. Do it only after the package has been tested
locally and the repository name is final.

## 1. Repository metadata

Already filled in for `warter666/dsh-compaction-fit`:

```json
"repository": { "type": "git", "url": "git+https://github.com/warter666/dsh-compaction-fit.git" },
"homepage": "https://github.com/warter666/dsh-compaction-fit#readme",
"bugs": { "url": "https://github.com/warter666/dsh-compaction-fit/issues" }
```

The npm package name (`dsh-compaction-fit`) must stay identical to the
repository name used in the awesome-list entry.

## 2. Pre-flight

```sh
node --test test/guard.test.mjs
npm pack --dry-run
```

`npm pack --dry-run` must list `index.js`, `cordis.patch.yml`, `README.md`,
`README.en.md` and `LICENSE`. `test/` is intentionally excluded from the tarball
but stays in the repository.

Optional end-to-end check in a scratch profile:

```sh
dsh plugin --profile scratch add ./dsh-compaction-fit-0.1.0.tgz
dsh --profile scratch --dump-config | grep -A 15 compaction-fit
```

## 3. Publish to npm

```sh
npm publish
```

`publishConfig.access` is already `public`. The name is currently unregistered;
re-check with `npm view dsh-compaction-fit version` before publishing.

## 4. Submit to the awesome list

The plugin market (Discover) reads its index from
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
Open a PR that adds **one file**, `data/plugins/warter666__dsh-compaction-fit.yml`:

```yaml
url: https://github.com/warter666/dsh-compaction-fit
name: warter666/dsh-compaction-fit
category: session
description:
  en: Fit DSH compaction prompts to real gateway limits: CJK-aware trimming, shrink-and-retry on prompt-too-long, and repair of pi-ai silent-overflow false positives.
  zh: 让 DSH 压缩摘要在本地 OpenAI 兼容网关上跑得完：按真实 token 预算裁剪、被拒时缩小重试，并纠正 pi-ai 的静默溢出误判。
```

Notes for the submission:

- `url` must match the repository exactly; `name` is `owner/repo`.
- `description.en` is required; keep it one line ending with a period, and quote
  it if it contains `: `.
- `category` is `session` (the compaction family). Alternatives: `model` (this is
  the closest if the reviewer prefers provider-level fixes).
- The repository already declares `dsh.bundle.patch`, which is the hard
  requirement for installability. There is no `dsh.client` half — this plugin is
  host-only.
- Submission is one file; do not edit the generated READMEs.

After merge the site and the market index refresh automatically (usually within
a day).

## 5. Later versions

Bump `version`, update the compatibility map if the DSH release line changes,
`npm publish`, and tag the repository. The market detects npm versions and
offers the update; the awesome-list entry does not need to change.
