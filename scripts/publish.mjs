#!/usr/bin/env node
/**
 * Obsidian Vault → Quartz content publisher.
 *
 * Copies only notes marked `publish: true` (and not `draft: true`) from a private
 * Obsidian vault into `content/`, together with the images they reference.
 * Obsidian links are rewritten for Quartz, links to unpublished notes are reduced
 * to plain text, private comments are stripped, and the result is scanned for
 * secrets and personal data before anything is written.
 *
 * Every file this script writes is recorded in `publish-manifest.json`, so notes
 * that are unpublished, deleted, renamed or re-categorised are removed on the next
 * run. Files that are not in the manifest (e.g. content/index.md) are never touched.
 *
 * Usage:
 *   node scripts/publish.mjs [--dry-run] [--commit] [--push] [--config <file>] [--vault <dir>]
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT = path.join(REPO, "content")
const MANIFEST_PATH = path.join(REPO, "publish-manifest.json")
const POSTS_DIR = "posts"
const ASSETS_DIR = "assets"
const ASSET_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "pdf", "mp4", "webm", "mp3",
])
const OUTPUT_FIELDS = ["title", "date", "updated", "description", "tags", "category"]
const PASSTHROUGH_FIELDS = ["enableToc", "comments", "lang"]

// ---------------------------------------------------------------- CLI & config

function parseArgs(argv) {
  const args = { dryRun: false, commit: false, push: false, config: null, vault: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run" || a === "-n") args.dryRun = true
    else if (a === "--commit") args.commit = true
    else if (a === "--push") args.push = args.commit = true
    else if (a === "--config") args.config = argv[++i]
    else if (a === "--vault") args.vault = argv[++i]
    else if (a === "--help" || a === "-h") {
      console.log("node scripts/publish.mjs [--dry-run] [--commit] [--push] [--config file] [--vault dir]")
      process.exit(0)
    } else fail(`Unknown argument: ${a}`)
  }
  return args
}

function loadConfig(args) {
  const configPath = path.resolve(REPO, args.config ?? "publish.config.json")
  let cfg = {}
  if (fs.existsSync(configPath)) cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
  else if (!args.vault && !process.env.VAULT_PATH)
    fail(`Config not found: ${configPath}\nCopy publish.config.example.json to publish.config.json and set vaultPath.`)
  const vaultPath = path.resolve(args.vault ?? process.env.VAULT_PATH ?? cfg.vaultPath ?? "")
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory())
    fail(`Vault directory not found: ${vaultPath}`)
  const inside = (a, b) => !path.relative(b, a).startsWith("..") && !path.isAbsolute(path.relative(b, a))
  if (inside(REPO, vaultPath) || inside(vaultPath, REPO))
    fail("The blog repository and the vault must not contain each other.")
  return {
    vaultPath,
    exclude: (cfg.exclude ?? []).map(globToRegex),
    excludeRaw: cfg.exclude ?? [],
    allowStrings: cfg.allowStrings ?? [],
    maxAssetBytes: cfg.maxAssetBytes ?? 10 * 1024 * 1024,
  }
}

// ---------------------------------------------------------------- utilities

const errors = []
const warnings = []
function fail(msg) {
  console.error(`✖ ${msg}`)
  process.exit(1)
}
const toPosix = (p) => p.split(path.sep).join("/")
const stripMd = (p) => p.replace(/\.md$/i, "")
const extOf = (p) => (p.match(/\.([^./]+)$/)?.[1] ?? "").toLowerCase()
const hashId = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16)

function globToRegex(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") {
          i++
          re += "(?:.*/)?"
        } else re += ".*"
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`, "i")
}

/** Path segment safe for URLs and every OS; keeps Unicode (e.g. Korean). */
function sanitizeSegment(s) {
  return String(s)
    .normalize("NFC")
    .trim()
    .replace(/[\\/:*?"<>|#%&^[\]{}`]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
}

function formatDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10)
  return null
}

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue
    const abs = path.join(dir, ent.name)
    // symlinks are skipped on purpose: they could point outside the vault
    if (ent.isDirectory()) walk(abs, base, out)
    else if (ent.isFile()) out.push(toPosix(path.relative(base, abs)))
  }
  return out
}

// ---------------------------------------------------------------- vault index

function buildIndex(files) {
  const byPath = new Map() // lowercased path → path
  const byBase = new Map() // lowercased basename → [paths]
  for (const f of files) {
    const isNote = extOf(f) === "md"
    const key = isNote ? stripMd(f) : f
    byPath.set(key.toLowerCase(), f)
    const base = key.split("/").pop().toLowerCase()
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(f)
  }
  return { byPath, byBase }
}

/** Resolve a link target the way Obsidian does (path, then relative, then unique basename). */
function resolveTarget(index, target, fromRel, { relativeFirst = false } = {}) {
  let t = target.trim().replace(/^\.\//, "").replace(/^\//, "")
  if (!t) return null
  const isNote = !extOf(t) || extOf(t) === "md"
  const key = (isNote ? stripMd(t) : t).normalize("NFC")
  const dir = path.posix.dirname(fromRel)
  const relKey = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, key))
  const candidates = relativeFirst ? [relKey, key] : [key, relKey]
  for (const c of candidates) {
    const hit = index.byPath.get(c.toLowerCase())
    if (hit && (extOf(hit) === "md") === isNote) return hit
  }
  if (key.includes("/") && relativeFirst) return null
  const base = key.split("/").pop().toLowerCase()
  const hits = (index.byBase.get(base) ?? []).filter((f) => (extOf(f) === "md") === isNote)
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]
  const sameDir = hits.find((h) => path.posix.dirname(h) === dir)
  return sameDir ?? [...hits].sort((a, b) => a.length - b.length)[0]
}

// ---------------------------------------------------------------- markdown processing

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const isFenceClose = (line, open) => {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/)
  return m && m[1][0] === open[0] && m[1].length >= open.length
}

/** Remove Obsidian `%% %%` and HTML `<!-- -->` comments outside code. */
function stripComments(body, ctx) {
  const out = []
  let fence = null
  let inPct = false
  let inHtml = false
  for (const line of body.split("\n")) {
    if (!inPct && !inHtml) {
      if (fence) {
        out.push(line)
        if (isFenceClose(line, fence)) fence = null
        continue
      }
      const m = line.match(FENCE_RE)
      if (m) {
        fence = m[1]
        out.push(line)
        continue
      }
    }
    const startedInComment = inPct || inHtml
    let res = ""
    let i = 0
    while (i < line.length) {
      if (inPct || inHtml) {
        const close = inPct ? "%%" : "-->"
        const j = line.indexOf(close, i)
        if (j < 0) {
          i = line.length
          break
        }
        inPct = inHtml = false
        i = j + close.length
        continue
      }
      if (line[i] === "`") {
        let n = 1
        while (line[i + n] === "`") n++
        const j = line.indexOf("`".repeat(n), i + n)
        if (j < 0) {
          res += line.slice(i)
          break
        }
        res += line.slice(i, j + n)
        i = j + n
        continue
      }
      if (line.startsWith("%%", i)) {
        inPct = true
        i += 2
      } else if (line.startsWith("<!--", i)) {
        inHtml = true
        i += 4
      } else res += line[i++]
    }
    if (!(startedInComment && res.trim() === "")) out.push(res)
  }
  if (inPct || inHtml) ctx.warn("unclosed comment: everything after it was removed")
  return out.join("\n")
}

/** Apply `fn` to text outside fenced code blocks and inline code spans. */
function mapOutsideCode(body, fn) {
  const lines = body.split("\n")
  const out = []
  let chunk = []
  let fence = null
  const flush = () => {
    if (!chunk.length) return
    const slots = []
    let text = chunk.join("\n").replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g, (m) => {
      slots.push(m)
      return `\u0000${slots.length - 1}\u0000`
    })
    text = fn(text).replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)])
    out.push(text)
    chunk = []
  }
  for (const line of lines) {
    if (fence) {
      out.push(line)
      if (isFenceClose(line, fence)) fence = null
      continue
    }
    const m = line.match(FENCE_RE)
    if (m) {
      flush()
      fence = m[1]
      out.push(line)
      continue
    }
    chunk.push(line)
  }
  flush()
  return out.join("\n")
}

function transformLinks(body, srcRel, ctx) {
  const { index, published, assetsFor } = ctx

  const resolve = (rawTarget, { embed, text, relativeFirst, pipe }) => {
    const hashAt = rawTarget.indexOf("#")
    const name = (hashAt >= 0 ? rawTarget.slice(0, hashAt) : rawTarget).trim()
    const anchor = hashAt >= 0 ? rawTarget.slice(hashAt) : ""
    const shown = text || (name ? name.split("/").pop().replace(/\.md$/i, "") : anchor.slice(1))
    if (!name) return null // same-page anchor: keep as is
    const hit = resolveTarget(index, name, srcRel, { relativeFirst })
    if (!hit) {
      ctx.warn(`unresolved link removed: ${name}`)
      return embed ? "" : shown
    }
    if (extOf(hit) === "md") {
      const out = published.get(hit)
      if (!out) {
        ctx.warn(`link to unpublished note reduced to text: ${name}`)
        return embed ? "" : `\u0002${shown}\u0003`
      }
      const target = stripMd(out.output) + anchor
      if (embed) return `![[${target}]]`
      return `[[${target}${pipe}${escapeAlias(shown)}]]`
    }
    const asset = assetsFor(hit)
    if (!asset) return embed ? "" : shown
    if (embed) return `![[${asset}${text ? pipe + text : ""}]]`
    return `[[${asset}${pipe}${escapeAlias(shown)}]]`
  }

  return mapOutsideCode(body, (text) =>
    text
      // Obsidian wikilinks and embeds: [[target#anchor|alias]], ![[image.png|300]]
      .replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (m, bang, inner) => {
        const escaped = inner.includes("\\|")
        const pipe = escaped ? "\\|" : "|"
        const [target, ...rest] = inner.split(escaped ? "\\|" : "|")
        const res = resolve(target, {
          embed: bang === "!",
          text: rest.join("|").trim(),
          relativeFirst: false,
          pipe,
        })
        return res ?? m
      })
      // Markdown links and images: [text](target), ![alt](path/img.png)
      .replace(
        /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g,
        (m, bang, label, rawTarget) => {
          let target = rawTarget.replace(/^<|>$/g, "")
          if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return m
          try {
            target = decodeURIComponent(target)
          } catch {}
          const res = resolve(target, {
            embed: bang === "!",
            text: label.trim(),
            relativeFirst: true,
            pipe: "|",
          })
          return res ?? m
        },
      )
      // a list item that only pointed to unpublished notes would just leak their names
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\u0002[^\u0003\n]*\u0003[\s,·]*)+$\n?/gm, "")
      .replace(/[\u0002\u0003]/g, ""),
  )
}

const escapeAlias = (s) => s.replace(/\]\]/g, "] ]").replace(/\|/g, "\\|")

function deriveDescription(body) {
  const text = body
    .replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1\s*$/gm, " ")
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/<[^>]+>|[*_~`]|^\s*\[![^\]]+\][+-]?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > 150 ? text.slice(0, 150).trimEnd() + "…" : text
}

// ---------------------------------------------------------------- sensitive data scan

const SENSITIVE_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["API secret key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    "credential assignment",
    /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']?(?![$<{%]|\*{3})[^\s"'`,;]{6,}/i,
  ],
  ["resident registration number", /\b\d{6}-[1-4]\d{6}\b/],
  ["phone number", /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ["local file path", /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//],
]
const EMAIL_SAFE = /@(example\.(com|org|net)|test\.com|users\.noreply\.github\.com)$/i

function scanSensitive(text, label, allowStrings) {
  const findings = []
  text.split("\n").forEach((line, i) => {
    let l = line
    for (const s of allowStrings) l = l.split(s).join("")
    for (const [kind, re] of SENSITIVE_PATTERNS) {
      const m = l.match(re)
      if (!m) continue
      if (kind === "email address" && EMAIL_SAFE.test(m[0])) continue
      const v = m[0]
      const masked = v.length <= 6 ? "***" : `${v.slice(0, 3)}…${v.slice(-2)}`
      findings.push(`${label}:${i + 1} ${kind} (${masked})`)
    }
  })
  return findings
}

/** JPEG EXIF GPS tag (0x8825) check — warn so location data is not leaked by photos. */
function hasExifGps(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false
  const head = buf.subarray(0, Math.min(buf.length, 128 * 1024))
  const exifAt = head.indexOf("Exif\0\0", 0, "latin1")
  if (exifAt < 0) return false
  const segLen = exifAt >= 2 ? head.readUInt16BE(exifAt - 2) : head.length
  const tiff = head.subarray(exifAt + 6, exifAt - 2 + segLen)
  return tiff.includes(Buffer.from([0x88, 0x25])) || tiff.includes(Buffer.from([0x25, 0x88]))
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig(args)
  const vault = cfg.vaultPath
  const files = walk(vault, vault, []).map((f) => f.normalize("NFC"))
  const index = buildIndex(files)
  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : { version: 1, files: [], entries: {} }

  // 1. find candidates
  const published = new Map() // vault rel path → { output, data, body, id }
  const outputs = new Map() // output path → vault rel path
  let skippedDraft = 0
  for (const rel of files.filter((f) => extOf(f) === "md")) {
    const raw = fs.readFileSync(path.join(vault, rel), "utf8")
    // cheap pre-filter: only notes that look like `publish: true` are parsed (templates etc. are ignored)
    if (!/^﻿?---\s*\r?\n/.test(raw) || !/^\s*publish\s*:\s*["']?true\b/im.test(raw)) continue
    let parsed
    try {
      parsed = matter(raw.replace(/^﻿/, "").replace(/\r\n/g, "\n"))
    } catch (e) {
      errors.push(`${rel}: front matter could not be parsed (${e.reason ?? e.message})`)
      continue
    }
    const data = parsed.data ?? {}
    if (data.publish !== true) {
      if (String(data.publish).toLowerCase() === "true")
        errors.push(`${rel}: publish must be a checkbox (boolean true), not the text "true"`)
      continue
    }
    if (data.draft === true || String(data.draft).toLowerCase() === "true") {
      skippedDraft++
      continue
    }
    const excludedBy = cfg.exclude.findIndex((re) => re.test(rel))
    if (excludedBy >= 0) {
      errors.push(`${rel}: publish: true is set, but the path matches exclude "${cfg.excludeRaw[excludedBy]}"`)
      continue
    }
    const date = formatDate(data.date)
    if (!date) {
      errors.push(`${rel}: "date" (YYYY-MM-DD) is required for published notes`)
      continue
    }
    const updated = data.updated == null || data.updated === "" ? null : formatDate(data.updated)
    if (data.updated && !updated) errors.push(`${rel}: "updated" must be YYYY-MM-DD`)
    if (updated && updated < date) warnings.push(`${rel}: updated (${updated}) is earlier than date (${date})`)

    const fileBase = rel.split("/").pop().replace(/\.md$/i, "")
    const slugRaw = typeof data.slug === "string" && data.slug.trim() ? data.slug.trim() : fileBase
    let output
    if (slugRaw.startsWith("/")) {
      const segs = slugRaw.split("/").map(sanitizeSegment).filter(Boolean)
      if (!segs.length) {
        errors.push(`${rel}: invalid slug "${slugRaw}"`)
        continue
      }
      output = `${segs.join("/")}.md`
    } else {
      const slug = sanitizeSegment(slugRaw)
      const cat = data.category ? sanitizeSegment(data.category) : ""
      if (!slug) {
        errors.push(`${rel}: could not derive a slug; set "slug" in front matter`)
        continue
      }
      output = [POSTS_DIR, cat, `${slug}.md`].filter(Boolean).join("/")
    }
    const outKey = output.toLowerCase()
    if (outputs.has(outKey)) {
      errors.push(`${rel}: output "${output}" collides with ${outputs.get(outKey)}; set a different slug`)
      continue
    }
    outputs.set(outKey, rel)
    published.set(rel, { output, data, body: parsed.content, date, updated, id: hashId(rel) })
  }

  // 2. transform
  const newFiles = new Map() // content-relative path → Buffer|string
  const newEntries = {}
  const findings = []
  for (const [rel, post] of published) {
    const warn = (msg) => warnings.push(`${rel}: ${msg}`)
    const assetDir = [ASSETS_DIR, ...stripMd(post.output).split("/").filter((s) => s !== POSTS_DIR)].join("/")
    const assetNames = new Map()
    const assetsFor = (assetRel) => {
      const ext = extOf(assetRel)
      if (!ASSET_EXTS.has(ext)) {
        warn(`attachment type .${ext} is not published: ${assetRel.split("/").pop()}`)
        return null
      }
      const abs = path.join(vault, assetRel)
      const size = fs.statSync(abs).size
      if (size > cfg.maxAssetBytes) {
        errors.push(`${rel}: attachment too large (${(size / 1048576).toFixed(1)} MB): ${assetRel.split("/").pop()}`)
        return null
      }
      if (assetNames.has(assetRel)) return assetNames.get(assetRel)
      let name = sanitizeSegment(assetRel.split("/").pop().replace(/\.[^.]+$/, "")) || "file"
      let out = `${assetDir}/${name}.${ext}`
      if ([...assetNames.values()].includes(out)) out = `${assetDir}/${name}-${hashId(assetRel).slice(0, 6)}.${ext}`
      const buf = fs.readFileSync(abs)
      if (hasExifGps(buf)) warn(`image may contain GPS location (EXIF): ${assetRel.split("/").pop()} — strip metadata before publishing`)
      if (ext === "svg") findings.push(...scanSensitive(buf.toString("utf8"), out, cfg.allowStrings))
      assetNames.set(assetRel, out)
      newFiles.set(out, buf)
      return out
    }
    const ctx = { index, published, assetsFor, warn }
    let body = stripComments(post.body, ctx)
    body = transformLinks(body, rel, ctx).replace(/^\n+/, "")

    const d = post.data
    const fm = {}
    fm.title = typeof d.title === "string" && d.title.trim() ? d.title.trim() : rel.split("/").pop().replace(/\.md$/i, "")
    fm.date = post.date
    if (post.updated) fm.updated = post.updated
    fm.description = typeof d.description === "string" && d.description.trim() ? d.description.trim() : deriveDescription(body)
    const tags = Array.isArray(d.tags) ? d.tags : typeof d.tags === "string" ? d.tags.split(/[,\s]+/) : []
    const cleanTags = tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
    if (cleanTags.length) fm.tags = cleanTags
    if (d.category) fm.category = String(d.category).trim()
    for (const k of PASSTHROUGH_FIELDS) if (d[k] !== undefined) fm[k] = d[k]

    // keep old URLs working after a slug/category change (Quartz alias redirects)
    const prev = manifest.entries?.[post.id]
    const redirects = new Set(prev?.redirects ?? [])
    if (prev && prev.output !== post.output) redirects.add(stripMd(prev.output))
    redirects.delete(stripMd(post.output))
    for (const r of redirects) if (outputs.has(`${r.toLowerCase()}.md`)) redirects.delete(r)
    if (redirects.size) fm.aliases = [...redirects].sort()
    fm.publish = true
    fm.draft = false
    newEntries[post.id] = { output: post.output, ...(redirects.size ? { redirects: [...redirects].sort() } : {}) }

    if (post.updated && post.updated !== post.date)
      body = `<p class="post-updated">최종 수정 <time datetime="${post.updated}">${post.updated}</time></p>\n\n${body}`
    const ordered = Object.fromEntries(
      [...OUTPUT_FIELDS, ...PASSTHROUGH_FIELDS, "aliases", "publish", "draft"].filter((k) => k in fm).map((k) => [k, fm[k]]),
    )
    const text = matter.stringify(body.endsWith("\n") ? body : body + "\n", ordered)
    findings.push(...scanSensitive(text, post.output, cfg.allowStrings))
    if (text.includes(vault) || text.includes(toPosix(vault))) findings.push(`${post.output}: contains the vault path`)
    newFiles.set(post.output, text)
  }

  // 3. plan file changes against the manifest
  const oldFiles = new Set(manifest.files ?? [])
  for (const out of newFiles.keys()) {
    if (!oldFiles.has(out) && fs.existsSync(path.join(CONTENT, out)))
      errors.push(`content/${out} already exists and is not managed by this script; remove or rename it first`)
  }
  const added = []
  const changed = []
  const unchanged = []
  for (const [out, data] of newFiles) {
    const abs = path.join(CONTENT, out)
    if (!fs.existsSync(abs)) added.push(out)
    else if (Buffer.compare(fs.readFileSync(abs), Buffer.from(data)) !== 0) changed.push(out)
    else unchanged.push(out)
  }
  const removed = [...oldFiles].filter((f) => !newFiles.has(f))

  // 4. report
  const list = (title, items) => items.length && console.log(`${title} (${items.length})\n${items.map((i) => `  ${i}`).join("\n")}`)
  console.log(`Vault: ${files.length} files scanned, ${published.size} to publish, ${skippedDraft} draft(s) skipped`)
  list("+ added", added)
  list("~ updated", changed)
  list("- removed", removed)
  console.log(`= unchanged: ${unchanged.length}`)
  list("⚠ warnings", [...new Set(warnings)])
  if (findings.length) {
    errors.push(
      "possible secrets / personal data found (remove them, or add the exact public string to allowStrings in publish.config.json):",
      ...findings.map((f) => `  ${f}`),
    )
  }
  if (errors.length) {
    console.error(`\n✖ Nothing was written:\n${errors.map((e) => `  ${e}`).join("\n")}`)
    process.exit(1)
  }
  if (args.dryRun) {
    console.log("\n(dry run — no files were changed)")
    return
  }

  // 5. write
  for (const out of removed) {
    const abs = path.join(CONTENT, out)
    if (fs.existsSync(abs)) fs.rmSync(abs)
    pruneEmptyDirs(path.dirname(abs))
  }
  for (const out of [...added, ...changed]) {
    const abs = path.join(CONTENT, out)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, newFiles.get(out))
  }
  const nextManifest = { version: 1, files: [...newFiles.keys()].sort(), entries: sortObj(newEntries) }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(nextManifest, null, 2) + "\n")
  console.log("\n✔ content/ updated")

  if (args.commit) gitCommit(args.push, { added, changed, removed })
}

function sortObj(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

function pruneEmptyDirs(dir) {
  while (dir.startsWith(CONTENT + path.sep) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir)
    dir = path.dirname(dir)
  }
}

function gitCommit(push, { added, changed, removed }) {
  const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" })
  git("add", "--", "content", "publish-manifest.json")
  if (!git("diff", "--cached", "--name-only").trim()) {
    console.log("Nothing to commit.")
  } else {
    const msg = `publish: +${added.length} ~${changed.length} -${removed.length} (${new Date().toISOString().slice(0, 10)})`
    git("commit", "-m", msg)
    console.log(`✔ committed: ${msg}`)
  }
  if (push) {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim()
    execFileSync("git", ["push", "origin", branch], { cwd: REPO, stdio: "inherit" })
    console.log(`✔ pushed ${branch} — GitHub Actions will deploy the site`)
  }
}

main()
