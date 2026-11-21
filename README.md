# himodu.dev

Source of the personal development blog at **https://himodu.github.io/**, built with [Quartz v5](https://quartz.jzhao.xyz) and deployed to GitHub Pages by GitHub Actions.

Posts are written in a private Obsidian vault. Only notes explicitly marked for publishing are copied into `content/` by [`scripts/publish.mjs`](scripts/publish.mjs); the vault itself never enters this repository.

## Publishing pipeline

```
Obsidian vault (private)            this repo (public)                 GitHub Pages
publish: true, draft: false  ──►  scripts/publish.mjs ──► content/ ──► Actions: quartz build ──► site
```

The publisher:

1. selects notes with `publish: true` (boolean) and `draft` not `true`, skipping excluded paths;
2. keeps only public front matter (`title`, `date`, `updated`, `description`, `tags`, `category`);
3. rewrites Obsidian links and embeds for Quartz, turns links to unpublished notes into plain text, and drops list items that only pointed to unpublished notes;
4. strips `%% %%` and HTML comments and copies only the images a published note embeds;
5. aborts without writing if it finds possible secrets or personal data;
6. tracks every generated file in `publish-manifest.json`, so unpublished, deleted, renamed or re-categorised posts are removed and old URLs redirect.

`date` in front matter is the published date (Git and file times are ignored); `updated` is shown as "최종 수정". `category` becomes the folder under `/posts/`.

## Commands

Requires Node.js 22+ and npm 10.9.2+.

| Command | What it does |
| --- | --- |
| `npm ci` | install dependencies |
| `npm run blog:check` | dry run: show what would be added, updated or removed |
| `npm run blog:publish` | update `content/` from the vault |
| `npm run blog:commit` | update `content/` and commit |
| `npm run blog:preview` | local preview at http://localhost:8080 |
| `git push origin v5` | deploy (GitHub Actions) |

Local settings go in `publish.config.json` (git-ignored); see [`publish.config.example.json`](publish.config.example.json).

## Repository layout

- `content/` — site content (`index.md` and `posts/index.md` are hand-written; the rest is generated)
- `scripts/publish.mjs` — vault → content publisher
- `quartz.config.yaml` — Quartz site configuration
- `.github/workflows/deploy.yml` — build and deploy (official Quartz GitHub Pages workflow)
- `quartz/`, `docs/` — Quartz itself (upstream: `jackyzha0/quartz`, MIT, see [`QUARTZ_README.md`](QUARTZ_README.md))
