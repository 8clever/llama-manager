#!/usr/bin/env bun
/**
 * llama-manager — browse llama.cpp releases, read their notes and install engine builds,
 * all from a terminal UI built with @opentui/core.
 *
 *   bun add @opentui/core
 *   bun index.ts
 *
 * Screen
 *   ┌ page: releases · artifacts · description · help ┐
 *   └─────────────────────────────────────────────────┘
 *   > input      plain text filters the current list, "/" opens the command dropdown
 *
 * Downloads are extracted to ./engines/<artifact-name>/ (relative to where you start the app).
 * Set GITHUB_TOKEN to lift GitHub's 60 requests/hour anonymous API limit.
 *
 * Only erasable TypeScript syntax and node: built-ins are used, so it also runs on Node.js.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  t,
  type KeyEvent,
  type SelectOption,
  type StyledText,
} from "@opentui/core"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { createGunzip, inflateRaw } from "node:zlib"

// ───────────────────────────────────────── config ─────────────────────────────────────────

const REPO = "ggml-org/llama.cpp"
const API = `https://api.github.com/repos/${REPO}`
const ENGINES_DIR = resolve(process.cwd(), "engines")
const DOWNLOADS_DIR = join(ENGINES_DIR, ".downloads")
const ENGINES_LABEL = `./${relative(process.cwd(), ENGINES_DIR).split(sep).join("/")}`
const PAGE_SIZE = 30 // releases per GitHub API request
const KEEP_ARCHIVES = false // keep the .zip/.tar.gz after a successful extraction
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const USER_AGENT = "llama-manager"

const C = {
  bg: "#11141c",
  panel: "#181c27",
  border: "#2f3649",
  text: "#c8d0e0",
  dim: "#6b7490",
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  err: "#f7768e",
  selBg: "#2a3a63",
  selFg: "#ffffff",
}

// ───────────────────────────────────────── types ──────────────────────────────────────────

interface Asset {
  id: number
  name: string
  size: number
  download_count: number
  browser_download_url: string
  digest?: string | null // "sha256:<hex>" — verified after download when present
}

interface Release {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at: string | null
  assets: Asset[]
}

type View = "releases" | "artifacts" | "notes" | "help"
type Tone = "info" | "ok" | "warn" | "error"

// ──────────────────────────────────────── helpers ─────────────────────────────────────────

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const truncate = (s: string, max: number): string =>
  max <= 0 ? "" : s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

const stripArchiveExt = (name: string): string => name.replace(/\.(tar\.gz|tgz|zip)$/i, "")

const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean)
const matchAll = (query: string[], haystack: string): boolean => query.every((w) => haystack.includes(w))

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "–"
  if (sec < 60) return `${Math.ceil(sec)}s`
  return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`
}

/** Turns GitHub-flavoured markdown into something readable in a terminal. */
function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1") // <url> → url
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/`([^`\n]+)`/g, "$1") // `code`
    .replace(/^#{1,6}\s+/gm, "") // # headings
    .replace(/^(\s*)[-*]\s+/gm, "$1• ") // - bullets
    .replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "────────────────") // --- rules
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const firstLine = (body: string | null): string =>
  cleanMarkdown((body ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "")

const releaseDate = (r: Release): string => (r.published_at ?? r.created_at).slice(0, 10)

const styled1 = (c: string, s: string): StyledText => t`${fg(c)(s)}`
const styled2 = (c1: string, s1: string, c2: string, s2: string): StyledText =>
  t`${fg(c1)(s1)}${fg(c2)(s2)}`

// ─────────────────────────────────────── GitHub API ───────────────────────────────────────

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`
  return h
}

async function ghFetch<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API}${endpoint}`, { headers: ghHeaders() })
  if (res.ok) return (await res.json()) as T
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000
    const when = reset ? new Date(reset).toLocaleTimeString() : "later"
    throw new Error(`GitHub rate limit reached (resets ${when}). Set GITHUB_TOKEN to raise it.`)
  }
  if (res.status === 404) throw new Error("Not found on GitHub")
  throw new Error(`GitHub API error: HTTP ${res.status}`)
}

// ─────────────────────────── archive extraction (.zip and .tar.gz) ───────────────────────────
// Pure node:zlib/node:fs, so it works the same on Windows, macOS and Linux with no external tools.

type EntryKind = "file" | "dir" | "symlink" | "hardlink"

interface ArchiveEntry {
  path: string // normalised, "/" separated
  kind: EntryKind
  mode: number // unix permission bits, 0 when unknown
  link?: string // symlink / hardlink target
  write?: (dest: string) => Promise<void> // writes the file contents to dest
}

type Progress = (done: number, total: number, name: string) => void

const inflateRawAsync = promisify(inflateRaw)

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  let off = 0
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off)
    if (bytesRead === 0) throw new Error("Unexpected end of archive (truncated file?)")
    off += bytesRead
  }
  return buf
}

const cleanPath = (p: string): string =>
  p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/")

/** Resolves rel inside root and refuses anything that would escape it ("zip-slip"). */
function safeJoin(root: string, rel: string): string {
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`Blocked unsafe path in archive: ${rel}`)
  return full
}

async function readZipEntries(fh: FileHandle): Promise<ArchiveEntry[]> {
  const { size } = await fh.stat()
  const tailLen = Math.min(size, 22 + 0xffff)
  const tail = await readAt(fh, size - tailLen, tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Not a valid .zip file")
  const count = tail.readUInt16LE(eocd + 10)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported yet")
  }
  const cd = await readAt(fh, cdOffset, cdSize)

  const entries: ArchiveEntry[] = []
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip directory")
    const madeBy = cd.readUInt16LE(p + 4)
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    const csize = cd.readUInt32LE(p + 20)
    const usize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const attrs = cd.readUInt32LE(p + 38)
    const offset = cd.readUInt32LE(p + 42)
    const rawName = cd.toString("utf8", p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new Error("Encrypted zip entries are not supported")

    const unixMode = (madeBy >> 8) === 3 ? attrs >>> 16 : 0
    const isDir = rawName.endsWith("/")
    const kind: EntryKind = isDir ? "dir" : (unixMode & 0o170000) === 0o120000 ? "symlink" : "file"
    const entry: ArchiveEntry = { path: cleanPath(rawName), kind, mode: unixMode & 0o777 }

    if (!isDir) {
      const load = async (): Promise<Buffer> => {
        const lh = await readAt(fh, offset, 30)
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("Corrupt zip entry")
        const start = offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
        const raw = await readAt(fh, start, csize)
        const data = method === 0 ? raw : method === 8 ? await inflateRawAsync(raw) : null
        if (!data) throw new Error(`Unsupported zip compression (method ${method})`)
        if (data.length !== usize) throw new Error(`Size mismatch for ${rawName}`)
        return data
      }
      if (kind === "symlink") entry.link = (await load()).toString("utf8")
      else entry.write = async (dest) => writeFile(dest, await load())
    }
    if (entry.path) entries.push(entry)
  }
  return entries
}

function tarSize(h: Buffer): number {
  if (((h[124] ?? 0) & 0x80) !== 0) {
    let v = 0 // GNU base-256 size
    for (let i = 125; i < 136; i++) v = v * 256 + (h[i] ?? 0)
    return v
  }
  return parseInt(h.toString("ascii", 124, 136), 8) || 0
}

async function copyRange(src: string, start: number, len: number, dest: string): Promise<void> {
  if (len === 0) return writeFile(dest, "")
  await pipeline(createReadStream(src, { start, end: start + len - 1 }), createWriteStream(dest))
}

/** Reads an *uncompressed* tar file: ustar, GNU long names (L/K) and PAX headers (x/g). */
async function readTarEntries(fh: FileHandle, tarPath: string): Promise<ArchiveEntry[]> {
  const { size } = await fh.stat()
  const entries: ArchiveEntry[] = []
  const str = (b: Buffer, off: number, len: number): string => {
    const s = b.toString("utf8", off, off + len)
    const z = s.indexOf("\0")
    return z < 0 ? s : s.slice(0, z)
  }
  let pos = 0
  let longName: string | undefined
  let longLink: string | undefined
  let pax: Record<string, string> = {}

  while (pos + 512 <= size) {
    const h = await readAt(fh, pos, 512)
    if (h.every((b) => b === 0)) break // end-of-archive marker
    let name = str(h, 0, 100)
    const mode = parseInt(h.toString("ascii", 100, 108), 8) || 0
    const fsize = tarSize(h)
    const typeByte = h[156] ?? 0
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte)
    let link = str(h, 157, 100)
    if (str(h, 257, 5) === "ustar") {
      const prefix = str(h, 345, 155)
      if (prefix) name = `${prefix}/${name}`
    }
    const dataPos = pos + 512
    pos = dataPos + Math.ceil(fsize / 512) * 512

    if (type === "L" || type === "K" || type === "x") {
      const data = (await readAt(fh, dataPos, fsize)).toString("utf8")
      if (type === "L") longName = data.replace(/\0+$/, "")
      else if (type === "K") longLink = data.replace(/\0+$/, "")
      else {
        pax = {}
        for (const line of data.split("\n")) {
          const m = /^\d+ ([^=]+)=(.*)$/.exec(line)
          if (m?.[1] !== undefined) pax[m[1]] = m[2] ?? ""
        }
      }
      continue
    }
    if (type === "g") continue // global PAX header: ignored

    if (longName !== undefined) name = longName
    if (pax.path) name = pax.path
    if (longLink !== undefined) link = longLink
    if (pax.linkpath) link = pax.linkpath
    longName = longLink = undefined
    pax = {}

    const path = cleanPath(name)
    if (!path) continue
    if (type === "5") entries.push({ path, kind: "dir", mode: mode & 0o777 })
    else if (type === "2") entries.push({ path, kind: "symlink", mode: mode & 0o777, link })
    else if (type === "1") entries.push({ path, kind: "hardlink", mode: mode & 0o777, link: cleanPath(link) })
    else if (type === "0" || type === "7") {
      entries.push({ path, kind: "file", mode: mode & 0o777, write: (dest) => copyRange(tarPath, dataPos, fsize, dest) })
    }
  }
  return entries
}

/** Writes entries below destRoot, dropping one shared top-level folder (tar.gz builds ship "llama-bXXXX/…"). */
async function materialize(
  entries: ArchiveEntry[],
  destRoot: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<number> {
  const tops = new Set(entries.map((e) => e.path.split("/")[0] ?? ""))
  const only = tops.size === 1 ? ([...tops][0] ?? "") : ""
  const nested = entries.every((e) => (e.path === only ? e.kind === "dir" : e.path.startsWith(`${only}/`)))
  const strip = only !== "" && nested ? 1 : 0
  const cut = (p: string): string => p.split("/").slice(strip).join("/")
  const plan = entries.map((e) => ({ e, rel: cut(e.path) })).filter((x) => x.rel !== "")

  // Validate everything first, so a malicious archive never leaves a half-written install behind.
  for (const { e, rel } of plan) {
    safeJoin(destRoot, rel)
    if (e.kind === "symlink") {
      const target = e.link ?? ""
      if (isAbsolute(target)) throw new Error(`Blocked absolute symlink in archive: ${rel}`)
      safeJoin(destRoot, join(dirname(rel), target)) // a symlink must stay inside destRoot too
    } else if (e.kind === "hardlink") {
      safeJoin(destRoot, cut(e.link ?? ""))
    }
  }

  await mkdir(destRoot, { recursive: true })
  let files = 0
  for (const [i, { e, rel }] of plan.entries()) {
    if (signal?.aborted) throw new Error("cancelled")
    onProgress(i + 1, plan.length, rel)
    const out = safeJoin(destRoot, rel)

    if (e.kind === "dir") {
      await mkdir(out, { recursive: true })
      continue
    }
    await mkdir(dirname(out), { recursive: true })
    await rm(out, { force: true }) // never write through an old symlink

    if (e.kind === "symlink") {
      await symlink(e.link ?? "", out).catch(() => undefined) // e.g. no symlink rights on Windows
      continue
    }
    if (e.kind === "hardlink") await copyFile(safeJoin(destRoot, cut(e.link ?? "")), out)
    else await e.write?.(out)
    if (e.mode) await chmod(out, e.mode | 0o600).catch(() => undefined) // keeps the executable bit
    files++
  }
  return files
}

async function extractArchive(file: string, destRoot: string, onProgress: Progress, signal?: AbortSignal): Promise<number> {
  const lower = file.toLowerCase()
  if (lower.endsWith(".zip")) {
    const fh = await open(file, "r")
    try {
      return await materialize(await readZipEntries(fh), destRoot, onProgress, signal)
    } finally {
      await fh.close()
    }
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const tarPath = `${file}.tar`
    try {
      onProgress(0, 0, "")
      await pipeline(createReadStream(file), createGunzip(), createWriteStream(tarPath), { signal })
      const fh = await open(tarPath, "r")
      try {
        return await materialize(await readTarEntries(fh, tarPath), destRoot, onProgress, signal)
      } finally {
        await fh.close()
      }
    } finally {
      await rm(tarPath, { force: true }).catch(() => undefined)
    }
  }
  throw new Error("Only .zip and .tar.gz archives can be extracted")
}

// ───────────────────────────────────────── download ─────────────────────────────────────────

interface DownloadState {
  asset: Asset
  phase: "downloading" | "extracting"
  received: number
  total: number
  startedAt: number
  done: number
  count: number
  current: string
  abort: AbortController
}

let dl: DownloadState | null = null

async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0
  while (off < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

async function download(asset: Asset): Promise<void> {
  if (dl) return flash("A download is already running — /cancel stops it", "warn")
  const st: DownloadState = {
    asset,
    phase: "downloading",
    received: 0,
    total: asset.size,
    startedAt: Date.now(),
    done: 0,
    count: 0,
    current: "",
    abort: new AbortController(),
  }
  dl = st
  const part = join(DOWNLOADS_DIR, `${asset.name}.part`)
  const archive = join(DOWNLOADS_DIR, asset.name)
  const folder = stripArchiveExt(asset.name)
  const dest = join(ENGINES_DIR, folder)
  renderStatus(true)

  try {
    await mkdir(DOWNLOADS_DIR, { recursive: true })
    const res = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": USER_AGENT },
      signal: st.abort.signal,
    })
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    st.total = Number(res.headers.get("content-length")) || asset.size

    const hash = createHash("sha256")
    const fh = await open(part, "w")
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        await writeAll(fh, value)
        st.received += value.length
      }
    } finally {
      await fh.close()
    }
    if (st.total > 0 && st.received !== st.total) throw new Error("Download was incomplete — please retry")
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : ""
    if (expected && hash.digest("hex") !== expected) throw new Error("SHA-256 mismatch — download discarded")
    await rename(part, archive)

    if (!/\.(zip|tar\.gz|tgz)$/i.test(asset.name)) {
      await rename(archive, join(ENGINES_DIR, asset.name))
      flash(`Saved ${ENGINES_LABEL}/${asset.name} (not an archive, nothing to extract)`, "ok", 15000)
      return
    }
    st.phase = "extracting"
    const files = await extractArchive(
      archive,
      dest,
      (done, count, name) => {
        st.done = done
        st.count = count
        st.current = name
      },
      st.abort.signal,
    )
    if (!KEEP_ARCHIVES) await rm(archive, { force: true })
    flash(`Installed ${ENGINES_LABEL}/${folder}  (${files} files)`, "ok", 15000)
  } catch (err) {
    await rm(part, { force: true }).catch(() => undefined)
    if (st.abort.signal.aborted) flash("Download cancelled", "warn")
    else {
      const kept = existsSync(archive) ? ` — archive kept in ${relative(process.cwd(), DOWNLOADS_DIR)}` : ""
      flash(`${errMsg(err)}${kept}`, "error", 15000)
    }
  } finally {
    dl = null
    refreshList(true) // refreshes the ✓ installed markers
    renderStatus(true)
  }
}

// ─────────────────────────────────────────── UI ───────────────────────────────────────────

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("llama-manager needs an interactive terminal.")
  process.exit(1)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false, // Ctrl+C is handled below so a running download is aborted first
  backgroundColor: C.bg,
})

const app = new BoxRenderable(renderer, { id: "app", width: "100%", height: "100%", flexDirection: "column" })

// page ─ header · body (list | description | help) · status line
const page = new BoxRenderable(renderer, {
  id: "page",
  flexGrow: 1,
  flexDirection: "column",
  border: true,
  borderStyle: "rounded",
  borderColor: C.border,
  title: " llama-manager ",
  titleColor: C.accent,
  paddingX: 1,
  overflow: "hidden",
})
const header = new TextRenderable(renderer, { id: "header", content: "", height: 2, wrapMode: "none", fg: C.text })
const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, flexDirection: "column", overflow: "hidden" })
const status = new TextRenderable(renderer, { id: "status", content: "", height: 1, wrapMode: "none", fg: C.dim })

const list = new SelectRenderable(renderer, {
  id: "list",
  flexGrow: 1,
  width: "100%",
  options: [],
  showDescription: false,
  showScrollIndicator: true,
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: C.text,
  focusedTextColor: C.text,
  selectedBackgroundColor: C.selBg,
  selectedTextColor: C.selFg,
})
const notes = new ScrollBoxRenderable(renderer, { id: "notes", flexGrow: 1, width: "100%", scrollY: true })
const notesText = new TextRenderable(renderer, { id: "notes-text", content: "", width: "100%", wrapMode: "word", fg: C.text })
const helpText = new TextRenderable(renderer, { id: "help", content: "", width: "100%", wrapMode: "none", fg: C.text })

notes.add(notesText)
body.add(list)
body.add(notes)
body.add(helpText)
page.add(header)
page.add(body)
page.add(status)

// input row ─ "> " + InputRenderable
const inputRow = new BoxRenderable(renderer, { id: "input-row", height: 1, flexDirection: "row" })
const prompt = new TextRenderable(renderer, { id: "prompt", content: "> ", width: 2, height: 1, fg: C.accent })
const input = new InputRenderable(renderer, {
  id: "input",
  flexGrow: 1,
  height: 1,
  placeholder: "type to filter · / for commands",
  maxLength: 200,
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: C.text,
  cursorColor: C.accent,
})
inputRow.add(prompt)
inputRow.add(input)

// command dropdown ─ floats above the input row, over the bottom of the page
const dropdownList = new SelectRenderable(renderer, {
  id: "dropdown-list",
  flexGrow: 1,
  width: "100%",
  options: [],
  showDescription: false,
  wrapSelection: true,
  backgroundColor: C.panel,
  focusedBackgroundColor: C.panel,
  textColor: C.text,
  focusedTextColor: C.text,
  selectedBackgroundColor: C.selBg,
  selectedTextColor: C.selFg,
})
const dropdown = new BoxRenderable(renderer, {
  id: "dropdown",
  position: "absolute",
  left: 0,
  bottom: 1,
  width: "100%",
  height: 3,
  zIndex: 10,
  border: true,
  borderStyle: "single",
  borderColor: C.accent,
  backgroundColor: C.panel,
  title: " commands ",
  titleColor: C.dim,
})
dropdown.add(dropdownList)
dropdown.visible = false

app.add(page)
app.add(inputRow)
app.add(dropdown)
renderer.root.add(app)
input.focus()

// ───────────────────────────────────────── app state ─────────────────────────────────────────

let view: View = "releases"
let backTo: View = "releases" // where the description / help views return to
let releases: Release[] = []
let nextPage = 1
let hasMore = true
let loading = false
let loadError = ""
let current: Release | null = null // release whose artifacts are shown
let notesRelease: Release | null = null // release whose description is shown
let filter = "" // live filter = the input text, unless it is a /command

const isListView = (): boolean => view === "releases" || view === "artifacts"

const visibleReleases = (): Release[] => {
  const q = words(filter)
  if (q.length === 0) return releases
  return releases.filter((r) => matchAll(q, `${r.tag_name} ${r.name ?? ""} ${releaseDate(r)} ${firstLine(r.body)}`.toLowerCase()))
}

const sortedAssets = (r: Release): Asset[] => [...r.assets].sort((a, b) => a.name.localeCompare(b.name))

const visibleAssets = (): Asset[] => {
  if (!current) return []
  const q = words(filter)
  const all = sortedAssets(current)
  return q.length === 0 ? all : all.filter((a) => matchAll(q, a.name.toLowerCase()))
}

const selectedRelease = (): Release | undefined =>
  view === "releases" ? (list.getSelectedOption()?.value as Release | undefined) : undefined

const selectedAsset = (): Asset | undefined =>
  view === "artifacts" ? (list.getSelectedOption()?.value as Asset | undefined) : undefined

const placeholder = (msg: string): SelectOption => ({ name: `  ${msg}`, description: "" })
const listWidth = (): number => Math.max(30, renderer.width - 8)

function releaseRow(r: Release): SelectOption {
  const head = `${r.tag_name.padEnd(8)} ${releaseDate(r)}  ${r.prerelease ? "[pre] " : ""}`
  return { name: head + truncate(firstLine(r.body), listWidth() - head.length), description: "", value: r }
}

function assetRow(a: Asset, nameWidth: number): SelectOption {
  const mark = existsSync(join(ENGINES_DIR, stripArchiveExt(a.name))) ? "✓" : " "
  const name = truncate(a.name, nameWidth).padEnd(nameWidth)
  return { name: `${mark} ${name}  ${formatBytes(a.size).padStart(8)}`, description: "", value: a }
}

function refreshList(keepSelection = false): void {
  if (!isListView()) return
  const previous = list.getSelectedIndex()
  let options: SelectOption[]
  if (view === "releases") {
    options = visibleReleases().map(releaseRow)
    if (options.length === 0) {
      options = [
        placeholder(
          loading
            ? "Loading releases…"
            : loadError || (releases.length ? "No release matches your filter" : "Nothing loaded — try /refresh"),
        ),
      ]
    }
  } else {
    const rows = visibleAssets()
    const widest = rows.reduce((m, a) => Math.max(m, a.name.length), 0)
    const nameWidth = Math.min(widest, Math.max(20, listWidth() - 14))
    options = rows.map((a) => assetRow(a, nameWidth))
    if (options.length === 0) options = [placeholder("No artifact matches your filter")]
  }
  list.options = options
  list.setSelectedIndex(keepSelection ? Math.max(0, Math.min(previous, options.length - 1)) : 0)
  renderHeader()
}

function renderHeader(): void {
  const room = Math.max(20, renderer.width - 6)
  let a = ""
  let b = ""
  if (view === "releases") {
    a = `Releases · ${REPO}`
    b = filter
      ? `${visibleReleases().length} of ${releases.length} match “${filter}”`
      : `${releases.length} loaded${hasMore ? " · /more for older" : ""}`
  } else if (view === "artifacts" && current) {
    a = `${current.tag_name} · ${releaseDate(current)}`
    const total = current.assets.length
    b = filter
      ? `${visibleAssets().length} of ${total} artifacts match “${filter}”`
      : `${total} artifacts · enter downloads and extracts to ${ENGINES_LABEL}/`
  } else if (view === "notes" && notesRelease) {
    a = `Description · ${notesRelease.tag_name}`
    b = `${releaseDate(notesRelease)} · ↑↓ pgup/pgdn scroll · tab to go back`
  } else if (view === "help") {
    a = "Help"
    b = "esc to go back"
  }
  header.content = t`${bold(fg(C.accent)(truncate(a, room)))}\n${fg(C.dim)(truncate(b, room))}`
}

function applyView(resetSelection = false): void {
  list.visible = isListView()
  notes.visible = view === "notes"
  helpText.visible = view === "help"
  if (isListView()) refreshList(!resetSelection)
  else renderHeader()
  renderStatus(true)
}

// ───────────────────────────────────────── status line ─────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const TONE: Record<Tone, string> = { info: C.text, ok: C.ok, warn: C.warn, error: C.err }
const HINTS: Record<View, string> = {
  releases: "↑↓ move · enter open · tab description · type to filter · / commands",
  artifacts: "↑↓ move · enter download · tab description · esc back · type to filter",
  notes: "↑↓ pgup/pgdn scroll · tab or esc to go back",
  help: "esc to go back",
}

let flashMsg: { text: string; tone: Tone; until: number } | null = null
let lastStatus = ""

function flash(text: string, tone: Tone = "info", ms = 6000): void {
  flashMsg = { text, tone, until: Date.now() + ms }
  renderStatus(true)
}

function bar(ratio: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function renderStatus(force = false): void {
  const spin = SPINNER[Math.floor(Date.now() / 90) % SPINNER.length] ?? "•"
  const room = Math.max(20, renderer.width - 6)
  let key: string
  let content: StyledText

  if (dl && dl.phase === "downloading") {
    const ratio = dl.total > 0 ? Math.min(1, dl.received / dl.total) : 0
    const rate = dl.received / Math.max(0.001, (Date.now() - dl.startedAt) / 1000)
    const eta = dl.total > 0 && rate > 0 ? (dl.total - dl.received) / rate : 0
    const head = `${spin} ${bar(ratio, 16)} ${String(Math.floor(ratio * 100)).padStart(3)}%`
    const tail = truncate(
      `  ${formatBytes(dl.received)} / ${formatBytes(dl.total)}  ${formatBytes(rate)}/s  eta ${formatDuration(eta)}  ${dl.asset.name}`,
      room - head.length,
    )
    key = head + tail
    content = styled2(C.accent, head, C.dim, tail)
  } else if (dl) {
    const head = `${spin} ${dl.count ? `extracting ${dl.done}/${dl.count}` : "decompressing…"}`
    const tail = truncate(dl.current ? `  ${dl.current}` : "", room - head.length)
    key = head + tail
    content = styled2(C.accent, head, C.dim, tail)
  } else if (loading) {
    key = `${spin} loading releases…`
    content = styled1(C.accent, key)
  } else if (flashMsg && flashMsg.until > Date.now()) {
    key = `${flashMsg.tone}:${flashMsg.text}`
    content = styled1(TONE[flashMsg.tone], truncate(flashMsg.text, room))
  } else {
    key = HINTS[view]
    content = styled1(C.dim, truncate(key, room))
  }
  if (!force && key === lastStatus) return
  lastStatus = key
  status.content = content
}

// ───────────────────────────────────── releases & navigation ─────────────────────────────────────

async function loadReleases(reset = false): Promise<void> {
  if (loading) return
  if (reset) {
    releases = []
    nextPage = 1
    hasMore = true
  }
  if (!hasMore) return flash("No older releases to load")
  loading = true
  loadError = ""
  refreshList(true)
  renderStatus(true)
  try {
    const page = await ghFetch<Release[]>(`/releases?per_page=${PAGE_SIZE}&page=${nextPage}`)
    const known = new Set(releases.map((r) => r.id))
    releases = releases.concat(page.filter((r) => !r.draft && !known.has(r.id)))
    hasMore = page.length === PAGE_SIZE
    nextPage++
  } catch (err) {
    loadError = errMsg(err)
    flash(loadError, "error", 12000)
  } finally {
    loading = false
    refreshList(true)
    renderStatus(true)
  }
}

function showReleases(): void {
  if (view !== "releases") {
    view = "releases"
    filter = ""
    setInputValue("")
    applyView(true)
  }
  if (releases.length === 0 && !loading) void loadReleases()
}

function openRelease(r: Release): void {
  current = r
  view = "artifacts"
  filter = ""
  setInputValue("")
  applyView(true)
}

async function openByTag(arg: string): Promise<void> {
  const wanted = arg.trim()
  if (!wanted) return flash("Usage: /open <tag>   e.g. /open b10456", "warn")
  const tag = /^\d+$/.test(wanted) ? `b${wanted}` : wanted
  const known = releases.find((r) => r.tag_name.toLowerCase() === tag.toLowerCase())
  if (known) return openRelease(known)
  flash(`Fetching ${tag}…`)
  openRelease(await ghFetch<Release>(`/releases/tags/${encodeURIComponent(tag)}`))
}

function showNotes(r: Release): void {
  if (isListView()) backTo = view
  notesRelease = r
  notesText.content = cleanMarkdown(r.body ?? "") || "(this release has no description)"
  notes.scrollTo(0)
  view = "notes"
  applyView()
}

function openNotes(): void {
  const r = view === "releases" ? selectedRelease() : (current ?? notesRelease ?? undefined)
  if (!r) return flash("Highlight a release first", "warn")
  showNotes(r)
}

function openArtifacts(): void {
  if (!current) return flash("Open a release first (enter on a release, or /open <tag>)", "warn")
  view = "artifacts"
  applyView()
}

function showHelp(): void {
  if (isListView()) backTo = view
  view = "help"
  applyView()
}

function goBack(): void {
  if (view === "notes" || view === "help") {
    view = backTo
    applyView()
  } else if (view === "artifacts") {
    const from = current
    view = "releases"
    filter = ""
    setInputValue("")
    applyView(true)
    const idx = from ? visibleReleases().indexOf(from) : -1
    if (idx > 0) list.setSelectedIndex(idx)
  }
}

function toggleNotes(): void {
  if (view === "notes" || view === "help") goBack()
  else openNotes()
}

function navigate(dir: 1 | -1, step: number, page: boolean): void {
  if (view === "notes") {
    if (page) notes.scrollBy(dir, "viewport")
    else notes.scrollBy(dir)
    return
  }
  if (!isListView()) return
  if (dir < 0) list.moveUp(step)
  else list.moveDown(step)
  const atEnd = list.getSelectedIndex() >= releases.length - 1
  if (dir > 0 && view === "releases" && !filter && hasMore && !loading && atEnd) void loadReleases()
}

function activateSelection(): void {
  if (view === "releases") {
    const r = selectedRelease()
    if (r) openRelease(r)
  } else if (view === "artifacts") {
    const a = selectedAsset()
    if (a) void download(a)
  } else {
    goBack()
  }
}

function quit(code = 0): never {
  dl?.abort.abort()
  clearInterval(ticker)
  renderer.destroy()
  process.exit(code)
}

// ───────────────────────────────────────── commands ─────────────────────────────────────────

interface Command {
  name: string
  aliases?: string[]
  args?: string
  desc: string
  run: (arg: string) => void | Promise<void>
}

const COMMANDS: Command[] = [
  { name: "releases", aliases: ["r"], desc: "List llama.cpp releases", run: showReleases },
  { name: "open", args: "<tag>", desc: "Open a release by tag, e.g. b10456", run: openByTag },
  { name: "notes", aliases: ["n", "desc"], desc: "Read the release description", run: openNotes },
  { name: "artifacts", aliases: ["a"], desc: "Show the opened release's artifacts", run: openArtifacts },
  {
    name: "download",
    aliases: ["dl"],
    desc: "Download + extract the highlighted artifact",
    run: () => {
      const a = selectedAsset()
      if (a) void download(a)
      else flash("Open a release and highlight an artifact first", "warn")
    },
  },
  {
    name: "cancel",
    desc: "Cancel the running download",
    run: () => (dl ? dl.abort.abort() : flash("No download is running")),
  },
  { name: "more", desc: "Load older releases", run: () => loadReleases() },
  { name: "refresh", aliases: ["reload"], desc: "Reload releases from GitHub", run: () => loadReleases(true) },
  { name: "back", aliases: ["b"], desc: "Go back", run: goBack },
  { name: "help", aliases: ["h", "?"], desc: "Show commands and keys", run: showHelp },
  { name: "quit", aliases: ["q", "exit"], desc: "Exit", run: () => quit() },
]

function runCommand(cmd: Command, arg: string): void {
  Promise.resolve()
    .then(() => cmd.run(arg))
    .catch((err: unknown) => flash(errMsg(err), "error", 10000))
}

function runCommandLine(line: string): void {
  const [head = "", ...rest] = line.trim().slice(1).split(/\s+/)
  const name = head.toLowerCase()
  const exact = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  const byPrefix = COMMANDS.filter((c) => c.name.startsWith(name))
  const cmd = exact ?? (byPrefix.length === 1 ? byPrefix[0] : undefined)
  if (!cmd) return flash(`Unknown command “/${name}” — type / to see all commands`, "warn")
  runCommand(cmd, rest.join(" "))
}

function helpContent(): string {
  const cmds = COMMANDS.map((c) => {
    const usage = `/${c.name}${c.args ? ` ${c.args}` : ""}`
    const alias = c.aliases?.length ? `  (${c.aliases.map((a) => `/${a}`).join(" ")})` : ""
    return `  ${usage.padEnd(16)}${c.desc}${alias}`
  })
  return [
    "Commands",
    ...cmds,
    "",
    "Keys",
    "  ↑ ↓            move (shift: 5 rows, pgup/pgdn: 10 rows, or one page in descriptions)",
    "  enter          open a release · download + extract the highlighted artifact",
    "  tab            toggle the release description (completes a command in the dropdown)",
    "  esc            close dropdown → clear input → go back",
    "  ctrl+c         quit",
    "",
    "Filtering",
    "  Type any text (no leading /) to filter the current list; all words must match: win cuda x64",
    "",
    `Downloads are extracted to ${ENGINES_LABEL}/<artifact-name>/`,
    GITHUB_TOKEN ? "GitHub API: authenticated (GITHUB_TOKEN)" : "GitHub API: anonymous, 60 requests/hour — set GITHUB_TOKEN to lift the limit",
  ].join("\n")
}

// ──────────────────────────────────── input line & dropdown ────────────────────────────────────

let suggestions: Command[] = []
let dismissed = false // Esc closes the dropdown until the next keystroke

/** Sets the input text and parks the cursor at the end (InputRenderable only moves it when typing). */
function setInputValue(text: string): void {
  input.value = text
  const c = input as unknown as { cursorPosition?: number; cursorOffset?: number }
  try {
    if (typeof c.cursorPosition === "number") c.cursorPosition = text.length
    else if (typeof c.cursorOffset === "number") c.cursorOffset = text.length
  } catch {
    // read-only on some versions: the cursor simply stays where the library put it
  }
}

const commandLabel = (c: Command): string => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(14)} ${c.desc}`

function hideDropdown(): void {
  dropdown.visible = false
}

function updateDropdown(value: string): void {
  if (dismissed || !value.startsWith("/") || /\s/.test(value)) return hideDropdown()
  const token = value.slice(1).toLowerCase()
  suggestions = COMMANDS.filter((c) => c.name.startsWith(token) || c.aliases?.some((a) => a.startsWith(token)))
  if (suggestions.length === 0) return hideDropdown()
  dropdownList.options = suggestions.map((c) => ({ name: commandLabel(c), description: "", value: c }))
  dropdownList.setSelectedIndex(0)
  dropdown.height = Math.min(suggestions.length, 8) + 2
  dropdown.visible = true
}

function completeSuggestion(): void {
  const cmd = suggestions[dropdownList.getSelectedIndex()]
  if (cmd) setInputValue(`/${cmd.name} `)
}

/** Enter inside the dropdown: run argument-less commands straight away, otherwise complete them. */
function acceptSuggestion(): void {
  const cmd = suggestions[dropdownList.getSelectedIndex()]
  if (!cmd) return
  const token = input.value.slice(1).toLowerCase()
  const exact = token === cmd.name || (cmd.aliases?.includes(token) ?? false)
  if (exact || !cmd.args) {
    setInputValue("")
    hideDropdown()
    runCommand(cmd, "")
  } else {
    setInputValue(`/${cmd.name} `)
  }
}

input.on(InputRenderableEvents.INPUT, (value: string) => {
  dismissed = false
  if (value.startsWith("/")) {
    if (filter) {
      filter = ""
      refreshList()
    }
    updateDropdown(value)
    return
  }
  hideDropdown()
  const next = value.trim()
  if (next !== filter) {
    filter = next
    refreshList()
  }
})

function onEnter(): void {
  const value = input.value
  if (!value.startsWith("/")) return activateSelection()
  if (dropdown.visible) return acceptSuggestion()
  setInputValue("")
  runCommandLine(value)
}

function onEscape(): void {
  if (dropdown.visible) {
    dismissed = true
    hideDropdown()
  } else if (input.value) {
    setInputValue("")
  } else {
    goBack()
  }
}

// Global keys run before the focused input sees them; preventDefault() keeps them out of the text.
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (key.ctrl && key.name === "c") return quit()
  switch (key.name) {
    case "up":
    case "down":
    case "pageup":
    case "pagedown": {
      key.preventDefault()
      const dir = key.name === "up" || key.name === "pageup" ? -1 : 1
      const page = key.name === "pageup" || key.name === "pagedown"
      if (dropdown.visible) {
        if (dir < 0) dropdownList.moveUp(page ? 5 : 1)
        else dropdownList.moveDown(page ? 5 : 1)
      } else {
        navigate(dir, page ? 10 : key.shift ? 5 : 1, page)
      }
      return
    }
    case "tab":
      key.preventDefault()
      if (dropdown.visible) completeSuggestion()
      else toggleNotes()
      return
    case "escape":
      key.preventDefault()
      return onEscape()
    case "return":
    case "enter":
      key.preventDefault()
      return onEnter()
  }
})

// ───────────────────────────────────────────── boot ─────────────────────────────────────────────

const ticker = setInterval(() => renderStatus(), 100) // spinner + progress + flash expiry
renderer.on("resize", () => {
  refreshList(true)
  renderStatus(true)
})
renderer.once("destroy", () => {
  clearInterval(ticker)
  dl?.abort.abort()
})

helpText.content = helpContent()
applyView(true)
void loadReleases()
