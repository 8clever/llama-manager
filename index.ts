#!/usr/bin/env bun
/**
 * llama-manager — manage llama.cpp from one terminal UI, built on @opentui/core.
 *
 *   /releases   browse llama.cpp releases, read notes, install engines into ./engines
 *   /models     search Hugging Face GGUF models, download quants into ./models, register them in models.ini
 *   /installed  manage downloaded models        /settings  edit config.ini and models.ini (options come from `llama-server --help`)
 *   /status     server logs + DRAM/VRAM usage   /start /stop  run llama-server in the background (survives closing the manager)
 *
 *   bun install && bun run index.ts
 * Env: GITHUB_TOKEN (lifts the 60 req/h GitHub limit), HF_TOKEN (gated Hugging Face repos).
 * Only erasable TypeScript + node: built-ins are used, so it also runs on Node.js.
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
import { execFile, spawn } from "node:child_process"
import { createHash, type Hash } from "node:crypto"
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { chmod, copyFile, mkdir, open, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises"
import { freemem, platform, totalmem } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { createGunzip, inflateRaw } from "node:zlib"

// ───────────────────────────────────────── config ─────────────────────────────────────────

const REPO = "ggml-org/llama.cpp"
const GH_API = `https://api.github.com/repos/${REPO}`
const HF = "https://huggingface.co"
const CWD = process.cwd()
const ENGINES_DIR = resolve(CWD, "engines")
const DOWNLOADS_DIR = join(ENGINES_DIR, ".downloads")
const LOGS_DIR = resolve(CWD, "logs")
const LOG_FILE = join(LOGS_DIR, "llama-server.log")
const PID_FILE = join(LOGS_DIR, "llama-server.pid.json")
const CONFIG_INI = resolve(CWD, "config.ini")
const PAGE_SIZE = 30 // releases per GitHub request
const KEEP_ARCHIVES = false // keep the .zip/.tar.gz after extraction
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const HF_TOKEN = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN
const USER_AGENT = "llama-manager"
const rel = (p: string): string => relative(CWD, p).split(sep).join("/") || "."

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
const PALETTE = ["#7dcfff", "#7aa2f7", "#bb9af7", "#f7768e", "#e0af68", "#7dcfff"] // banner gradient (wraps)

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

interface HfModel {
  id: string
  likes: number
  downloads: number
  createdAt?: string
  lastModified?: string
  gated?: boolean | string
}

interface HfFile {
  type: string
  path: string
  size: number
  lfs?: { oid: string; size: number }
}

interface Quant {
  label: string
  key: string
  files: HfFile[]
  size: number
  mmproj: boolean
}

interface OptionInfo {
  key: string // name used in models.ini: the long flag without dashes
  flags: string[]
  metavar: string
  desc: string
  env: string
  def: string
  group: string
  boolean: boolean
  choices: string[]
}

type View =
  | "welcome"
  | "releases"
  | "artifacts"
  | "models"
  | "quants"
  | "installed"
  | "settings"
  | "cfg-manager"
  | "cfg-sections"
  | "cfg-section"
  | "cfg-catalog"
  | "notes"
  | "status"
  | "help"
type Tone = "info" | "ok" | "warn" | "error"
type SortKey = "trending" | "likes" | "downloads" | "created" | "updated"

// ──────────────────────────────────────── helpers ─────────────────────────────────────────

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const truncate = (s: string, max: number): string =>
  max <= 0 ? "" : s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
const stripArchiveExt = (name: string): string => name.replace(/\.(tar\.gz|tgz|zip)$/i, "")
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean)
const matchAll = (query: string[], haystack: string): boolean => query.every((w) => haystack.includes(w))
const splitArgs = (s: string): string[] =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"))
const isOn = (v: string): boolean => /^(1|on|true|yes|enabled?)$/i.test(v.trim())

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
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0)

function ago(iso?: string): string {
  const s = (Date.now() - Date.parse(iso ?? "")) / 1000
  if (!Number.isFinite(s)) return "–"
  for (const [n, u] of [[31536000, "y"], [2592000, "mo"], [86400, "d"], [3600, "h"], [60, "m"]] as const) {
    if (s >= n) return `${Math.floor(s / n)}${u}`
  }
  return "now"
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
const styled2 = (c1: string, s1: string, c2: string, s2: string): StyledText => t`${fg(c1)(s1)}${fg(c2)(s2)}`

function mix(a: string, b: string, f: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return `#${pa.map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * f).toString(16).padStart(2, "0")).join("")}`
}

/** Colour at position x of the wrapping banner gradient. */
function paletteAt(x: number): string {
  const p = (x - Math.floor(x)) * (PALETTE.length - 1)
  const i = Math.floor(p)
  return mix(PALETTE[i] ?? "#ffffff", PALETTE[i + 1] ?? "#ffffff", p - i)
}

// ─────────────────────────────── INI files (config.ini / models.ini) ───────────────────────────────
// Line based, so comments, blank lines, ordering, key alignment and CRLF survive edits untouched.

interface Ini {
  file: string
  lines: string[]
  eol: string
}
interface Section {
  name: string
  start: number // header line
  end: number // exclusive
}
interface Kv {
  key: string
  value: string
  line: number
}

const SECTION_RE = /^\s*\[(.+?)\]\s*$/
const KV_RE = /^(\s*)([^=;#[\s][^=]*?)(\s*=\s*)(.*?)\s*$/

function iniLoad(file: string): Ini {
  if (!existsSync(file)) return { file, lines: [], eol: "\n" }
  const text = readFileSync(file, "utf8")
  return { file, lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" }
}

function iniSave(ini: Ini): void {
  const lines = [...ini.lines]
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  mkdirSync(dirname(ini.file), { recursive: true })
  writeFileSync(`${ini.file}.tmp`, lines.join(ini.eol) + ini.eol)
  renameSync(`${ini.file}.tmp`, ini.file)
}

function iniSections(ini: Ini): Section[] {
  const out: Section[] = []
  ini.lines.forEach((l, i) => {
    const m = SECTION_RE.exec(l)
    if (!m) return
    const prev = out.at(-1)
    if (prev) prev.end = i
    out.push({ name: m[1] ?? "", start: i, end: ini.lines.length })
  })
  return out
}

function iniKeys(ini: Ini, section: string): Kv[] {
  const s = iniSections(ini).find((x) => x.name === section)
  const out: Kv[] = []
  if (!s) return out
  for (let i = s.start + 1; i < s.end; i++) {
    const m = KV_RE.exec(ini.lines[i] ?? "")
    if (m) out.push({ key: (m[2] ?? "").trim(), value: m[4] ?? "", line: i })
  }
  return out
}

const iniGet = (ini: Ini, section: string, key: string): string | undefined =>
  iniKeys(ini, section).find((k) => k.key === key)?.value

const iniFindKey = (ini: Ini, section: string, names: string[]): string | undefined =>
  iniKeys(ini, section).find((k) => names.includes(k.key))?.key

function iniSet(ini: Ini, section: string, key: string, value: string): void {
  const kvs = iniKeys(ini, section)
  const hit = kvs.find((k) => k.key === key)
  if (hit) {
    const m = KV_RE.exec(ini.lines[hit.line] ?? "")
    ini.lines[hit.line] = `${m?.[1] ?? ""}${m?.[2] ?? key}${m?.[3] ?? " = "}${value}` // keeps the original alignment
    return
  }
  const entry = `${key.padEnd(20)} = ${value}`
  const s = iniSections(ini).find((x) => x.name === section)
  if (s) {
    ini.lines.splice((kvs.at(-1)?.line ?? s.start) + 1, 0, entry)
    return
  }
  while (ini.lines.length > 0 && ini.lines[ini.lines.length - 1] === "") ini.lines.pop()
  if (ini.lines.length > 0) ini.lines.push("")
  ini.lines.push(`[${section}]`, entry, "")
}

function iniUnset(ini: Ini, section: string, key: string): boolean {
  const hit = iniKeys(ini, section).find((k) => k.key === key)
  if (hit) ini.lines.splice(hit.line, 1)
  return !!hit
}

function iniRemoveSection(ini: Ini, section: string): boolean {
  const s = iniSections(ini).find((x) => x.name === section)
  if (!s) return false
  const from = s.start > 0 && ini.lines[s.start - 1] === "" ? s.start - 1 : s.start // swallow the separating blank line
  ini.lines.splice(from, s.end - from)
  return true
}

// ───────────────────────────── manager configuration (config.ini) ─────────────────────────────

interface CfgKey {
  key: string
  def: string
  desc: string
  choices?: () => string[]
}

const installedEngines = (): string[] => {
  try {
    return readdirSync(ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}
const engineRel = (name: string): string => `engines/${name}`

const MANAGER_KEYS: CfgKey[] = [
  {
    key: "engine-path",
    def: "",
    desc: "Engine folder used by /start, e.g. engines/llama-b11438-bin-win-cuda-13.4-x64",
    choices: () => installedEngines().map(engineRel),
  },
  { key: "models-dir", def: "models", desc: "Folder for downloaded GGUF models (also passed to --models-dir)" },
  { key: "mmproj-dir", def: "mmproj", desc: "Folder for multimodal projector (mmproj) files" },
  { key: "models-ini", def: "models.ini", desc: "Preset file passed to --models-preset" },
  { key: "server-args", def: "", desc: "Extra arguments appended to /start, e.g. --host 0.0.0.0 --port 8080" },
  {
    key: "download-mmproj",
    def: "true",
    desc: "Also download the repo's mmproj file when a quant is downloaded",
    choices: () => ["true", "false"],
  },
]

const cfgGet = (key: string): string => iniGet(iniLoad(CONFIG_INI), "*", key) ?? MANAGER_KEYS.find((k) => k.key === key)?.def ?? ""

function cfgSet(key: string, value: string): void {
  const ini = iniLoad(CONFIG_INI)
  if (value.trim() === "") iniUnset(ini, "*", key)
  else iniSet(ini, "*", key, value.trim().replace(/\\/g, "/"))
  iniSave(ini)
}

const enginePathAbs = (): string => {
  const v = cfgGet("engine-path")
  return v ? resolve(CWD, v) : ""
}
const modelsDir = (): string => resolve(CWD, cfgGet("models-dir") || "models")
const mmprojDir = (): string => resolve(CWD, cfgGet("mmproj-dir") || "mmproj")
const modelsIniPath = (): string => resolve(CWD, cfgGet("models-ini") || "models.ini")

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
  const res = await fetch(`${GH_API}${endpoint}`, { headers: ghHeaders() })
  if (res.ok) return (await res.json()) as T
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000
    const when = reset ? new Date(reset).toLocaleTimeString() : "later"
    throw new Error(`GitHub rate limit reached (resets ${when}). Set GITHUB_TOKEN to raise it.`)
  }
  if (res.status === 404) throw new Error("Not found on GitHub")
  throw new Error(`GitHub API error: HTTP ${res.status}`)
}

// ───────────────────────────────────── Hugging Face API ─────────────────────────────────────

const SORTS: Record<SortKey, { param: string; label: string }> = {
  trending: { param: "trendingScore", label: "trending" },
  likes: { param: "likes", label: "most likes" },
  downloads: { param: "downloads", label: "most downloads" },
  created: { param: "createdAt", label: "recently created" },
  updated: { param: "lastModified", label: "recently updated" },
}

const hfHeaders = (): Record<string, string> => ({
  "User-Agent": USER_AGENT,
  ...(HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
})

async function hfJson<T>(url: string, signal?: AbortSignal): Promise<{ data: T; next: string | null }> {
  const res = await fetch(url, { headers: hfHeaders(), signal })
  if (res.status === 401 || res.status === 403) throw new Error("Hugging Face denied access (gated repo? set HF_TOKEN)")
  if (res.status === 404) throw new Error("Not found on Hugging Face")
  if (res.status === 429) throw new Error("Hugging Face rate limit reached — try again shortly")
  if (!res.ok) throw new Error(`Hugging Face error: HTTP ${res.status}`)
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null
  return { data: (await res.json()) as T, next }
}

function hfListUrl(search: string, sort: SortKey): string {
  const p = new URLSearchParams({ filter: "gguf", sort: SORTS[sort].param, direction: "-1", limit: "50" })
  if (search) p.set("search", search)
  for (const f of ["downloads", "likes", "createdAt", "lastModified", "gated"]) p.append("expand[]", f)
  return `${HF}/api/models?${p}`
}

async function hfFiles(repo: string, signal?: AbortSignal): Promise<HfFile[]> {
  let url: string | null = `${HF}/api/models/${repo}/tree/main?recursive=true`
  const out: HfFile[] = []
  for (let i = 0; url && i < 10; i++) {
    const { data, next }: { data: HfFile[]; next: string | null } = await hfJson<HfFile[]>(url, signal)
    out.push(...data.filter((f) => f.type === "file" && /\.gguf$/i.test(f.path)))
    url = next
  }
  return out
}

const hfResolveUrl = (repo: string, path: string): string =>
  `${HF}/${repo}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}?download=true`

const SHARD = /-\d{5}-of-\d{5}\.gguf$/i
const QUANT = /(?:^|[-_.])((?:UD-)?(?:IQ|TQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?)(?=[-_.]|$)/i

/** Groups GGUF files into downloadable quants (split "-00001-of-00003" shards become one row). */
function groupQuants(files: HfFile[]): Quant[] {
  const groups = new Map<string, Quant>()
  for (const f of files) {
    const key = f.path.replace(SHARD, ".gguf")
    const stem = basename(key).replace(/\.gguf$/i, "")
    const mm = /mmproj/i.test(stem)
    let g = groups.get(key)
    if (!g) {
      const q = QUANT.exec(stem)?.[1]
      g = { label: mm ? `mmproj ${q ?? ""}`.trim() : (q ?? stem), key, files: [], size: 0, mmproj: mm }
      groups.set(key, g)
    }
    g.files.push(f)
    g.size += f.size
  }
  for (const g of groups.values()) g.files.sort((a, b) => a.path.localeCompare(b.path))
  return [...groups.values()].sort((a, b) => Number(a.mmproj) - Number(b.mmproj) || a.size - b.size)
}

const MMPROJ_PREF = ["f16", "bf16", "f32", "q8_0"]
const pickMmproj = (all: Quant[]): Quant | undefined =>
  all
    .filter((q) => q.mmproj)
    .sort((a, b) => {
      const ra = MMPROJ_PREF.findIndex((p) => a.label.toLowerCase().includes(p))
      const rb = MMPROJ_PREF.findIndex((p) => b.label.toLowerCase().includes(p))
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.size - b.size
    })[0]

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

// ───────────────────────────────── downloads (resumable, checksummed) ─────────────────────────────────

interface FileSpec {
  url: string
  dest: string
  size: number
  sha256?: string
  headers?: Record<string, string>
}

interface Job {
  title: string
  phase: "downloading" | "extracting"
  total: number
  base: number // bytes of finished files
  received: number // base + bytes of the current file (including a resumed part)
  startBytes: number // bytes that were already on disk when the job started
  fileNo: number
  fileCount: number
  startedAt: number
  done: number
  count: number
  current: string
  abort: AbortController
}

let job: Job | null = null

async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0
  while (off < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

async function hashFile(file: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
}

/** Downloads to <dest>.part and resumes it with a Range request after an interruption. */
async function downloadFile(spec: FileSpec, j: Job): Promise<void> {
  await mkdir(dirname(spec.dest), { recursive: true })
  const part = `${spec.dest}.part`
  let have = existsSync(part) ? statSync(part).size : 0
  if (spec.size > 0 && have > spec.size) {
    await rm(part, { force: true })
    have = 0
  }
  let hash = createHash("sha256")
  if (have > 0) await hashFile(part, hash)
  if (j.fileNo === 1) j.startBytes = have
  j.received = j.base + have

  if (!(spec.size > 0 && have === spec.size)) {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...spec.headers }
    if (have > 0) headers.Range = `bytes=${have}-`
    const res = await fetch(spec.url, { headers, signal: j.abort.signal })
    if (res.status === 416) {
      await rm(part, { force: true }) // stale partial file: start over
      return downloadFile(spec, j)
    }
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    if (have > 0 && res.status !== 206) {
      have = 0 // the server ignored Range: restart from zero
      hash = createHash("sha256")
      j.received = j.base
    }
    const fh = await open(part, have > 0 ? "a" : "w")
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        await writeAll(fh, value)
        j.received += value.length
      }
    } finally {
      await fh.close()
    }
  }
  const size = statSync(part).size
  if (spec.size > 0 && size !== spec.size) throw new Error("Download incomplete — run it again to resume")
  if (spec.sha256 && hash.digest("hex") !== spec.sha256.toLowerCase()) {
    await rm(part, { force: true })
    throw new Error("SHA-256 mismatch — the file was discarded")
  }
  await rename(part, spec.dest)
  j.base += size
}

async function runJob(title: string, files: FileSpec[], after: (j: Job) => Promise<string>): Promise<void> {
  if (job) return flash("A download is already running — /cancel stops it", "warn")
  const j: Job = {
    title,
    phase: "downloading",
    total: files.reduce((n, f) => n + f.size, 0),
    base: 0,
    received: 0,
    startBytes: 0,
    fileNo: 0,
    fileCount: files.length,
    startedAt: Date.now(),
    done: 0,
    count: 0,
    current: "",
    abort: new AbortController(),
  }
  job = j
  flashMsg = null // a new job supersedes old messages, so they cannot mask its progress
  renderStatus(true)
  try {
    for (const [i, f] of files.entries()) {
      j.fileNo = i + 1
      await downloadFile(f, j)
    }
    const done = await after(j)
    job = null
    flash(done, "ok", 15000)
  } catch (err) {
    job = null
    if (j.abort.signal.aborted) flash("Cancelled — partial files are kept, run it again to resume", "warn")
    else flash(errMsg(err), "error", 15000)
  } finally {
    job = null
    onJobDone()
  }
}

function installArtifact(asset: Asset): Promise<void> {
  const folder = stripArchiveExt(asset.name)
  const dest = join(ENGINES_DIR, folder)
  const archive = join(DOWNLOADS_DIR, asset.name)
  const sha256 = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined
  return runJob(asset.name, [{ url: asset.browser_download_url, dest: archive, size: asset.size, sha256 }], async (j) => {
    if (!/\.(zip|tar\.gz|tgz)$/i.test(asset.name)) {
      await rename(archive, join(ENGINES_DIR, asset.name))
      return `Saved ${rel(join(ENGINES_DIR, asset.name))} (not an archive, nothing to extract)`
    }
    j.phase = "extracting"
    let files: number
    try {
      files = await extractArchive(archive, dest, (d, n, name) => ((j.done = d), (j.count = n), (j.current = name)), j.abort.signal)
    } catch (err) {
      throw j.abort.signal.aborted ? err : new Error(`${errMsg(err)} (archive kept in ${rel(DOWNLOADS_DIR)})`)
    }
    if (!KEEP_ARCHIVES) await rm(archive, { force: true })
    const cur = enginePathAbs()
    const selected = !cur || !existsSync(cur)
    if (selected) cfgSet("engine-path", engineRel(folder))
    return `Installed ${rel(dest)} (${files} files)${selected ? " · selected as engine" : ""}`
  })
}

function downloadQuant(repo: string, q: Quant, all: Quant[]): Promise<void> {
  const spec = (qq: Quant, dir: string): FileSpec[] =>
    qq.files.map((f) => ({ url: hfResolveUrl(repo, f.path), dest: join(dir, basename(f.path)), size: f.size, sha256: f.lfs?.oid, headers: hfHeaders() }))
  const own = spec(q, q.mmproj ? mmprojDir() : modelsDir())
  const mm = !q.mmproj && cfgGet("download-mmproj") !== "false" ? pickMmproj(all) : undefined
  const mmSpecs = mm ? spec(mm, mmprojDir()) : []
  const todo = [...own, ...mmSpecs.filter((s) => !existsSync(s.dest))]
  return runJob(`${repo} · ${q.label}`, todo, async () => {
    const first = own[0]?.dest ?? ""
    if (q.mmproj) return `Downloaded ${rel(first)} (set it as mmproj on a model in /settings)`
    const name = basename(q.key).replace(/\.gguf$/i, "")
    const ini = iniLoad(modelsIniPath())
    iniSet(ini, name, "model", rel(first))
    if (mmSpecs[0]) iniSet(ini, name, "mmproj", rel(mmSpecs[0].dest))
    iniSave(ini)
    return `Downloaded ${name} → added to ${rel(modelsIniPath())}${mmSpecs[0] ? " (with mmproj)" : ""}`
  })
}

// ─────────────────────────────── engine discovery and --help catalog ───────────────────────────────

const EXE = platform() === "win32" ? ".exe" : ""

function findServerBinary(dir: string): { bin: string; sub: string[] } | null {
  for (const d of [dir, join(dir, "bin")]) {
    if (existsSync(join(d, `llama-server${EXE}`))) return { bin: join(d, `llama-server${EXE}`), sub: [] }
    if (existsSync(join(d, `llama${EXE}`))) return { bin: join(d, `llama${EXE}`), sub: ["serve"] } // unified CLI
  }
  return null
}

function engineEnv(dir: string): NodeJS.ProcessEnv {
  const win = platform() === "win32"
  const key = win ? "PATH" : platform() === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH"
  const old = process.env[key]
  return { ...process.env, [key]: old ? `${dir}${win ? ";" : ":"}${old}` : dir }
}

function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 8000, maxBuffer: 16 << 20, windowsHide: true },
      (err, stdout, stderr) => res({ ok: !err, out: `${stdout}\n${stderr}` }),
    )
  })
}

const versionCache = new Map<string, string>()
async function engineVersion(dir: string): Promise<string> {
  const hit = versionCache.get(dir)
  if (hit) return hit
  const found = findServerBinary(dir)
  if (!found) return "no llama-server binary"
  const r = await runCapture(found.bin, ["--version"], { env: engineEnv(dir) })
  const m = /version:\s*(\d+)\s*\(([0-9a-f]+)\)/i.exec(r.out)
  if (!m) return r.out.split("\n").find((l) => l.trim())?.trim() ?? "unknown"
  const v = `b${m[1]} (${m[2]})`
  versionCache.set(dir, v)
  return v
}

// CLI actions rather than settings — everything else is taken from `--help` as printed by the engine.
const NON_SETTINGS = /^(help|usage|version|license|cache-list|completion-bash|list-devices)$/

/**
 * Parses llama.cpp's `--help`: a spec column ("-t,    --threads N") padded to column 40, then the description,
 * continuation lines indented by 40 spaces, "----- group -----" headings, "(default: …)" and "(env: …)" notes.
 */
function parseHelp(text: string): OptionInfo[] {
  const lines = text.replace(/\r/g, "").split("\n")
  const out: OptionInfo[] = []
  const seen = new Set<string>()
  let group = "options"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const g = /^-{3,}\s*(.+?)\s*-{3,}$/.exec(line)
    if (g) {
      group = g[1] ?? group
      continue
    }
    if (!/^-{1,2}[A-Za-z0-9]/.test(line)) continue
    let spec = line.trimEnd()
    const parts: string[] = []
    if (line.length > 40 && line.slice(37, 40).trim() === "") {
      spec = line.slice(0, 40).trimEnd()
      parts.push(line.slice(40).trim())
    }
    while (/^ {20,}\S/.test(lines[i + 1] ?? "")) parts.push((lines[++i] ?? "").trim())

    const tokens = spec.split(/,\s+/)
    const last = tokens.pop() ?? ""
    const sp = last.indexOf(" ")
    const flags = [...tokens.map((x) => x.trim()), sp < 0 ? last : last.slice(0, sp)].filter((f) => f.startsWith("-"))
    const metavar = sp < 0 ? "" : last.slice(sp + 1).trim()
    const longs = flags.filter((f) => f.startsWith("--"))
    const positive = longs.filter((f) => !(f.startsWith("--no-") && longs.includes(`--${f.slice(5)}`)))
    const key = (positive.at(-1) ?? longs.at(-1) ?? flags[0] ?? "").replace(/^-+/, "")
    if (!key || NON_SETTINGS.test(key) || seen.has(key)) continue
    seen.add(key)

    const full = parts.join(" ").replace(/\s+/g, " ").trim()
    const inline = /^[[<{]([\w.\-+| ,]+)[\]>}]$/.exec(metavar)?.[1]
    let choices = inline && /[|,]/.test(inline) ? inline.split(/[|,]\s*/).map((s) => s.trim()).filter(Boolean) : []
    const allowed = /allowed values:\s*(.+?)(?=\s*\((?:default|env)|$)/i.exec(full)?.[1]
    if (choices.length === 0 && allowed) choices = allowed.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
    out.push({
      key,
      flags,
      metavar,
      desc: full.replace(/\s*\(env:[^)]*\)/, "").trim(),
      env: /\(env:\s*([A-Z0-9_]+)\)/.exec(full)?.[1] ?? "",
      def: /\(default:\s*([^)]*)\)/.exec(full)?.[1]?.trim() ?? "",
      group,
      boolean: metavar === "",
      choices,
    })
  }
  return out
}

const catalogCache = new Map<string, OptionInfo[]>()
async function loadCatalog(dir: string): Promise<OptionInfo[]> {
  const hit = catalogCache.get(dir)
  if (hit) return hit
  const found = findServerBinary(dir)
  if (!found) throw new Error(`No llama-server binary found in ${rel(dir)}`)
  const r = await runCapture(found.bin, [...found.sub, "--help"], { env: engineEnv(dir), timeout: 15000 })
  const list = parseHelp(r.out)
  if (list.length === 0) throw new Error("Could not read any options from `llama-server --help`")
  catalogCache.set(dir, list)
  return list
}

// ─────────────────────────────────── background server (/start, /stop) ───────────────────────────────────

interface PidInfo {
  pid: number
  bin: string
  engine: string
  args: string[]
  startedAt: number
}
interface ServerState {
  running: boolean
  pid: number
  startedAt: number
  url: string
}

let server: ServerState = { running: false, pid: 0, startedAt: 0, url: "" }
const logLines: string[] = []
let logPos = 0
let logPartial = ""

function readPid(): PidInfo | null {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as PidInfo
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Guards against a recycled PID: never trust (or kill) a process that does not look like llama-server. */
async function looksLikeLlama(pid: number): Promise<boolean> {
  try {
    if (platform() === "linux") return /llama/i.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"))
    if (platform() === "win32") {
      const r = await runCapture("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 4000 })
      return r.ok ? /llama/i.test(r.out) : true
    }
    const r = await runCapture("ps", ["-p", String(pid), "-o", "command="], { timeout: 4000 })
    return r.ok ? /llama/i.test(r.out) : true
  } catch {
    return false
  }
}

function serverUrlFromLog(): string {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const l = logLines[i] ?? ""
    const m = /listening (?:on|at) (https?:\/\/\S+)/i.exec(l)
    if (m) return m[1] ?? ""
    if (l.startsWith("=== ")) break
  }
  return ""
}

async function refreshServer(): Promise<void> {
  const info = readPid()
  if (!info || !pidAlive(info.pid) || (!(server.running && server.pid === info.pid) && !(await looksLikeLlama(info.pid)))) {
    if (info) rmSync(PID_FILE, { force: true }) // stale pid file
    server = { running: false, pid: 0, startedAt: 0, url: "" }
    return
  }
  server = { running: true, pid: info.pid, startedAt: info.startedAt, url: serverUrlFromLog() }
}

async function startServer(): Promise<string> {
  await refreshServer()
  if (server.running) throw new Error(`Server is already running (pid ${server.pid}) — /stop it first`)
  const dir = enginePathAbs()
  if (!dir || !existsSync(dir)) throw new Error("No engine selected — install one in /releases or pick one with /use")
  const found = findServerBinary(dir)
  if (!found) throw new Error(`No llama-server binary found in ${rel(dir)}`)
  const ini = modelsIniPath()
  if (!existsSync(ini)) throw new Error(`${rel(ini)} not found — download a model first (/models)`)
  mkdirSync(modelsDir(), { recursive: true })
  const args = [...found.sub, "--ui-mcp-proxy", "--models-dir", modelsDir(), "--models-preset", ini, ...splitArgs(cfgGet("server-args"))]

  mkdirSync(LOGS_DIR, { recursive: true })
  const fd = openSync(LOG_FILE, "a")
  writeSync(fd, `\n=== ${new Date().toISOString()} starting: ${found.bin} ${args.join(" ")} ===\n`)
  // Detached + its own stdio file: the server keeps running when the manager exits.
  const child = spawn(found.bin, args, { cwd: CWD, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: engineEnv(dir) })
  closeSync(fd)
  await new Promise<void>((res, rej) => {
    child.once("error", rej)
    child.once("spawn", () => res())
  })
  const pid = child.pid ?? 0
  const pidInfo: PidInfo = { pid, bin: found.bin, engine: dir, args, startedAt: Date.now() }
  writeFileSync(PID_FILE, JSON.stringify(pidInfo))
  child.unref()

  const early = await new Promise<number | null>((res) => {
    const timer = setTimeout(() => res(null), 1500)
    child.once("exit", (code) => {
      clearTimeout(timer)
      res(code ?? 1)
    })
  })
  pollLog()
  if (early !== null) {
    rmSync(PID_FILE, { force: true })
    const why = [...logLines].reverse().find((l) => l.trim() && !l.startsWith("===")) ?? "no output"
    throw new Error(`llama-server exited immediately (code ${early}): ${truncate(why.trim(), 120)}`)
  }
  await refreshServer()
  return `Server started (pid ${pid}) · logs: ${rel(LOG_FILE)}`
}

async function stopServer(): Promise<string> {
  const info = readPid()
  if (!info || !pidAlive(info.pid) || !(await looksLikeLlama(info.pid))) {
    rmSync(PID_FILE, { force: true })
    await refreshServer()
    return "Server is not running"
  }
  if (platform() === "win32") {
    await runCapture("taskkill", ["/PID", String(info.pid), "/T", "/F"], { timeout: 10000 })
  } else {
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-info.pid, sig) // the whole process group: the router and its model children
      } catch {
        try {
          process.kill(info.pid, sig)
        } catch {
          /* already gone */
        }
      }
    }
    signal("SIGTERM")
    for (let i = 0; i < 40 && pidAlive(info.pid); i++) await sleep(150)
    if (pidAlive(info.pid)) {
      signal("SIGKILL")
      await sleep(250)
    }
  }
  rmSync(PID_FILE, { force: true })
  writeFileSync(LOG_FILE, `=== ${new Date().toISOString()} stopped by llama-manager (pid ${info.pid}) ===\n`, { flag: "a" })
  await refreshServer()
  return `Server stopped (pid ${info.pid})`
}

/** Reads what the server appended to its log since the last call (first call: the last 64 KB). */
function pollLog(): boolean {
  let size: number
  try {
    size = statSync(LOG_FILE).size
  } catch {
    return false
  }
  if (size < logPos) {
    logPos = 0 // truncated or rotated
    logLines.length = 0
    logPartial = ""
  }
  if (size === logPos) return false
  const first = logPos === 0 && size > 65536
  const start = first ? size - 65536 : logPos
  const len = Math.min(size - start, 1 << 20)
  const buf = Buffer.alloc(len)
  const fd = openSync(LOG_FILE, "r")
  try {
    readSync(fd, buf, 0, len, start)
  } finally {
    closeSync(fd)
  }
  logPos = start + len
  let text = logPartial + buf.toString("utf8")
  if (first) text = text.slice(text.indexOf("\n") + 1) // drop the cut-off first line
  const parts = text.split(/\r?\n/)
  logPartial = parts.pop() ?? ""
  logLines.push(...parts.map(stripAnsi))
  if (logLines.length > 3000) logLines.splice(0, logLines.length - 2000)
  return parts.length > 0
}

// ─────────────────────────────────────── DRAM / VRAM sampling ───────────────────────────────────────

interface Gpu {
  name: string
  used: number
  total: number
}
interface Stats {
  ramUsed: number
  ramTotal: number
  gpus: Gpu[]
  gpuNote: string
}

let stats: Stats = { ramUsed: 0, ramTotal: totalmem(), gpus: [], gpuNote: "checking GPUs…" }
let gpuTool: "unknown" | "nvidia" | "rocm" | "none" = "unknown"
let statsBusy = false

async function sampleStats(): Promise<void> {
  if (statsBusy) return
  statsBusy = true
  try {
    let used = totalmem() - freemem()
    if (platform() === "linux") {
      try {
        const avail = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]
        if (avail) used = totalmem() - Number(avail) * 1024
      } catch {
        /* keep os.freemem() */
      }
    }
    const gpus: Gpu[] = []
    if (gpuTool === "unknown" || gpuTool === "nvidia") {
      const r = await runCapture("nvidia-smi", ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 4000 })
      for (const line of r.ok ? r.out.split("\n") : []) {
        const [name, u, tot] = line.split(",").map((s) => s.trim())
        if (name && Number.isFinite(Number(u)) && Number.isFinite(Number(tot)) && u && tot) {
          gpus.push({ name, used: Number(u) * 1048576, total: Number(tot) * 1048576 })
        }
      }
      gpuTool = r.ok ? "nvidia" : "rocm"
    }
    if (gpuTool === "rocm") {
      const r = await runCapture("rocm-smi", ["--showmeminfo", "vram", "--json"], { timeout: 4000 })
      try {
        const data = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)) as Record<string, Record<string, string>>
        for (const [card, v] of Object.entries(data)) {
          const total = Number(v["VRAM Total Memory (B)"])
          const u = Number(v["VRAM Total Used Memory (B)"])
          if (Number.isFinite(total) && Number.isFinite(u) && total > 0) gpus.push({ name: card, used: u, total })
        }
      } catch {
        /* not an AMD system */
      }
      if (gpus.length === 0) gpuTool = "none"
    }
    const note = gpus.length > 0 ? "" : platform() === "darwin" ? "Apple GPU: unified memory — see RAM" : "no nvidia-smi / rocm-smi found"
    stats = { ramUsed: used, ramTotal: totalmem(), gpus, gpuNote: note }
  } finally {
    statsBusy = false
  }
}

// ───────────────────────────────── downloaded models (models.ini) ─────────────────────────────────

interface Local {
  name: string
  model: string
  mmproj: string
  files: string[]
  size: number
  exists: boolean
}

/** A split model ("x-00001-of-00003.gguf") lives in several files. */
function modelFiles(abs: string): string[] {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(abs)
  if (!m) return [abs]
  return Array.from({ length: Number(m[3]) }, (_, i) => `${m[1]}-${String(i + 1).padStart(5, "0")}-of-${m[3]}.gguf`)
}

function localModels(): Local[] {
  const ini = iniLoad(modelsIniPath())
  return iniSections(ini)
    .filter((s) => s.name !== "*")
    .map((s) => {
      const model = iniGet(ini, s.name, "model") ?? ""
      const files = model ? modelFiles(resolve(CWD, model)) : []
      const present = files.filter((f) => existsSync(f))
      return {
        name: s.name,
        model,
        mmproj: iniGet(ini, s.name, "mmproj") ?? "",
        files,
        size: present.reduce((n, f) => n + statSync(f).size, 0),
        exists: files.length > 0 && present.length === files.length,
      }
    })
}

/** Deletes the model files and its [section]; files outside models/mmproj dirs are never touched. */
function removeLocal(m: Local): string {
  const inside = (p: string): boolean => [modelsDir(), mmprojDir()].some((d) => p.startsWith(d + sep))
  const ini = iniLoad(modelsIniPath())
  iniRemoveSection(ini, m.name)
  const shared = new Set(iniSections(ini).map((s) => iniGet(ini, s.name, "mmproj")).filter((p): p is string => !!p).map((p) => resolve(CWD, p)))
  const mm = m.mmproj ? resolve(CWD, m.mmproj) : ""
  const targets = [...m.files, ...(mm && !shared.has(mm) ? [mm] : [])]
  let removed = 0
  let kept = 0
  for (const f of targets) {
    if (!existsSync(f)) continue
    if (inside(f)) {
      rmSync(f, { force: true })
      removed++
    } else kept++
  }
  iniSave(ini)
  return `Removed ${m.name} · ${removed} file(s) deleted${kept ? `, ${kept} outside ${rel(modelsDir())} left alone` : ""}`
}

// ═════════════════════════════════════════════ UI ═════════════════════════════════════════════

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("llama-manager needs an interactive terminal.")
  process.exit(1)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false, // Ctrl+C is handled below so a running download is aborted first (the server is never killed)
  backgroundColor: C.bg,
})

const row = (id: string, height = 1, color = C.text): TextRenderable =>
  new TextRenderable(renderer, { id, content: "", height, width: "100%", wrapMode: "none", fg: color })

const BANNER = [
  "██╗     ██╗      █████╗ ███╗   ███╗ █████╗ ",
  "██║     ██║     ██╔══██╗████╗ ████║██╔══██╗",
  "██║     ██║     ███████║██╔████╔██║███████║",
  "██║     ██║     ██╔══██║██║╚██╔╝██║██╔══██║",
  "███████╗███████╗██║  ██║██║ ╚═╝ ██║██║  ██║",
  "╚══════╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝",
]

const selectStyle = {
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: C.text,
  focusedTextColor: C.text,
  selectedBackgroundColor: C.selBg,
  selectedTextColor: C.selFg,
}

const app = new BoxRenderable(renderer, { id: "app", width: "100%", height: "100%", flexDirection: "column" })
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
const header = row("header", 2)
const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, flexDirection: "column", overflow: "hidden" })
const statusLine = row("statusline", 1, C.dim)

// welcome: gradient banner · tagline · dashboard · menu
const welcome = new BoxRenderable(renderer, { id: "welcome", flexGrow: 1, width: "100%", flexDirection: "column" })
const bannerRows = BANNER.map((_, i) => row(`banner-${i}`))
const tagline = row("tagline")
const gap1 = row("gap1")
const dEngine = row("dash-engine")
const dModels = row("dash-models")
const dServer = row("dash-server")
const dMemory = row("dash-memory")
const gap2 = row("gap2")
const menu = new SelectRenderable(renderer, {
  id: "menu",
  flexGrow: 1,
  width: "100%",
  options: [],
  showDescription: false,
  wrapSelection: true,
  ...selectStyle,
})
for (const w of [...bannerRows, tagline, gap1, dEngine, dModels, dServer, dMemory, gap2, menu]) welcome.add(w)

// generic list (releases, artifacts, models, quants, installed, settings…) with an optional 2-line detail
const list = new SelectRenderable(renderer, {
  id: "list",
  flexGrow: 1,
  width: "100%",
  options: [],
  showDescription: false,
  showScrollIndicator: true,
  ...selectStyle,
})
const detail = new TextRenderable(renderer, { id: "detail", content: "", height: 2, width: "100%", wrapMode: "word", fg: C.dim })

// notes (release description / model card) and help
const notes = new ScrollBoxRenderable(renderer, { id: "notes", flexGrow: 1, width: "100%", scrollY: true })
const notesText = new TextRenderable(renderer, { id: "notes-text", content: "", width: "100%", wrapMode: "word", fg: C.text })
notes.add(notesText)
const helpText = new TextRenderable(renderer, { id: "help", content: "", width: "100%", wrapMode: "none", fg: C.text })

// status page: engine · server · models · RAM · GPUs · log tail
const statusBox = new BoxRenderable(renderer, { id: "status-box", flexGrow: 1, width: "100%", flexDirection: "column", overflow: "hidden" })
const sEngine = row("s-engine")
const sServer = row("s-server")
const sModels = row("s-models")
const sRam = row("s-ram")
const sGpu = [0, 1, 2, 3].map((i) => row(`s-gpu-${i}`))
const sLogTitle = row("s-logtitle")
const logView = row("log", 3)
for (const w of [sEngine, sServer, sModels, sRam, ...sGpu, sLogTitle, logView]) statusBox.add(w)

for (const w of [welcome, list, detail, notes, helpText, statusBox]) body.add(w)
page.add(header)
page.add(body)
page.add(statusLine)

// input row: prompt + InputRenderable
const inputRow = new BoxRenderable(renderer, { id: "input-row", height: 1, flexDirection: "row" })
const prompt = new TextRenderable(renderer, { id: "prompt", content: "> ", width: 2, height: 1, fg: C.accent })
const input = new InputRenderable(renderer, {
  id: "input",
  flexGrow: 1,
  height: 1,
  placeholder: "type to filter · / for commands",
  maxLength: 300,
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: C.text,
  cursorColor: C.accent,
})
inputRow.add(prompt)
inputRow.add(input)

// dropdown: floats above the input row, over the bottom of the page
const dropdownList = new SelectRenderable(renderer, {
  id: "dropdown-list",
  flexGrow: 1,
  width: "100%",
  options: [],
  showDescription: false,
  wrapSelection: true,
  ...selectStyle,
  backgroundColor: C.panel,
  focusedBackgroundColor: C.panel,
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

interface Row {
  label: string
  value?: unknown
  search?: string
}
interface ViewDef {
  kind: "menu" | "list" | "notes" | "help" | "status"
  hint: string
  title: () => string
  sub: (n: { shown: number; total: number }) => string
  rows?: () => Row[]
  empty?: () => string
  filter?: "local" | "remote"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: (v: any) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enter?: (v: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tab?: (v: any) => void
  atEnd?: () => void
  onEnter?: () => void
}
interface Editing {
  label: string
  choices: () => string[]
  pristine: boolean
  commit: (value: string) => void
}
interface Sugg {
  label: string
  insert: string
  cmd?: Command
  arg?: string
}
interface Command {
  name: string
  aliases?: string[]
  args?: string
  desc: string
  complete?: (arg: string) => string[]
  run: (arg: string) => void | Promise<void>
}

let view: View = "welcome"
let stack: View[] = []
let filter = ""
let shownRows: Row[] = []
const memory: Partial<Record<View, unknown>> = {}

let releases: Release[] = []
let nextPage = 1
let hasMore = true
let loading = false
let loadError = ""
let current: Release | null = null

let hfSort: SortKey = "trending"
let hfItems: HfModel[] = []
let hfNext: string | null = null
let hfLoading = false
let hfError = ""
let hfQuery = "" // the search that produced hfItems
let hfSeq = 0
let hfAbort: AbortController | null = null
let searchTimer: ReturnType<typeof setTimeout> | undefined
let repo: HfModel | null = null
let quants: Quant[] = []
let quantsState = ""

let notesTitle = ""
let notesSub = ""
let notesToken = 0

let cfgSection = "*"
let catalog: OptionInfo[] | null = null
let catalogFor = ""
let catalogState = ""

let editing: Editing | null = null
let suggestions: Sugg[] = []
let dismissed = false
let silent = false
let armed: { name: string; until: number } | null = null

let engineVer = ""
let logScroll = 0
let logRows = 10
let menuRunning: boolean | null = null
let tickCount = 0
let flashMsg: { text: string; tone: Tone; until: number } | null = null
let lastStatus = ""

const TOP: View[] = ["welcome", "releases", "models", "installed", "settings", "status"]
const SORT_KEYS = Object.keys(SORTS) as SortKey[]
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const TONE: Record<Tone, string> = { info: C.text, ok: C.ok, warn: C.warn, error: C.err }

// ───────────────────────────────────────── rendering ─────────────────────────────────────────

const listWidth = (): number => Math.max(30, renderer.width - 8)
const placeholder = (msg: string): SelectOption => ({ name: `  ${msg}`, description: "" })
const gib = (n: number): string => (n / 1073741824).toFixed(1)
const usageColor = (r: number): string => (r < 0.6 ? C.ok : r < 0.85 ? C.warn : C.err)
const sel = (): unknown => (view === "welcome" ? menu : list).getSelectedOption()?.value

function bar(ratio: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function flash(text: string, tone: Tone = "info", ms = 6000): void {
  flashMsg = { text, tone, until: Date.now() + (job ? Math.min(ms, 2500) : ms) } // during a download messages are brief
  renderStatus(true)
}

function renderHeader(n = { shown: 0, total: 0 }): void {
  const def = VIEWS[view]
  const room = Math.max(20, renderer.width - 6)
  header.content = t`${bold(fg(C.accent)(truncate(def.title(), room)))}\n${fg(C.dim)(truncate(def.sub(n), room))}`
}

function updateDetail(): void {
  const def = VIEWS[view]
  if (def.kind !== "list" || !def.detail) return
  const v = sel()
  detail.content = styled1(C.dim, v === undefined ? "" : def.detail(v))
}

function refreshList(keep = false): void {
  const def = VIEWS[view]
  if (def.kind !== "list") return
  const prev = list.getSelectedIndex()
  const all = def.rows?.() ?? []
  const q = def.filter === "local" ? words(filter) : []
  shownRows = q.length ? all.filter((r) => matchAll(q, (r.search ?? r.label).toLowerCase())) : all
  list.options = shownRows.length
    ? shownRows.map((r) => ({ name: r.label, description: "", value: r.value }))
    : [placeholder(def.empty?.() ?? "Nothing here")]
  list.setSelectedIndex(keep ? Math.max(0, Math.min(prev, shownRows.length - 1)) : 0)
  renderHeader({ shown: shownRows.length, total: all.length })
  updateDetail()
}

function refreshMenu(): void {
  const prev = menu.getSelectedIndex()
  const items: [string, string, string][] = [
    ["releases", "Releases", "browse llama.cpp releases · read notes · install engines"],
    ["models", "Models", "search Hugging Face GGUF models · download quants"],
    ["installed", "Installed", "downloaded models and their models.ini entries"],
    ["settings", "Settings", "config.ini and models.ini (options read from the engine)"],
    ["status", "Status", "server logs · DRAM / VRAM usage"],
    server.running
      ? ["stop", "Stop server", "stop the background llama-server"]
      : ["start", "Start server", "run llama-server in the background"],
  ]
  menu.options = items.map(([v, name, desc]) => ({ name: `${name.padEnd(13)} ${desc}`, description: "", value: v }))
  menu.setSelectedIndex(Math.min(prev, items.length - 1))
  menuRunning = server.running
}

function layoutWelcome(): void {
  const tiny = renderer.height - 4 < 19 || renderer.width < 50
  for (const r of bannerRows) r.visible = !tiny
  gap1.visible = !tiny
  tagline.content = tiny
    ? t`${bold(fg(C.accent)("◆ llama-manager"))}${fg(C.dim)("  engines · models · server")}`
    : t`${fg(C.dim)("llama.cpp engines · Hugging Face models · one terminal")}`
}

function animateBanner(): void {
  const phase = Date.now() / 7000
  BANNER.forEach((line, r) => {
    const seg = (i: number) => fg(paletteAt(phase + (i * 5) / 70 + r * 0.035))(line.slice(i * 5, i * 5 + 5))
    const target = bannerRows[r]
    if (target) target.content = t`${seg(0)}${seg(1)}${seg(2)}${seg(3)}${seg(4)}${seg(5)}${seg(6)}${seg(7)}${seg(8)}`
  })
}

function renderDash(): void {
  const eng = enginePathAbs()
  const ok = !!eng && existsSync(eng)
  const label = (s: string) => fg(C.dim)(s.padEnd(9))
  dEngine.content = t`${label("engine")}${fg(ok ? C.ok : C.warn)(ok ? basename(eng) : "none yet — open Releases and install one")}${fg(C.dim)(ok && engineVer ? `  ${engineVer}` : "")}`
  const lm = localModels()
  dModels.content = t`${label("models")}${fg(C.text)(`${lm.length} in ${basename(modelsIniPath())}`)}${fg(C.dim)(`  ·  ${formatBytes(lm.reduce((n, m) => n + m.size, 0))} on disk`)}`
  dServer.content = server.running
    ? t`${label("server")}${fg(C.ok)("● running")}${fg(C.text)(`  pid ${server.pid}  ·  up ${formatDuration((Date.now() - server.startedAt) / 1000)}`)}${fg(C.accent)(server.url ? `  ·  ${server.url}` : "")}`
    : t`${label("server")}${fg(C.dim)("○ stopped  ·  /start launches it in the background")}`
  const ram = stats.ramTotal ? stats.ramUsed / stats.ramTotal : 0
  const g = stats.gpus[0]
  dMemory.content = t`${label("memory")}${fg(usageColor(ram))(`RAM ${bar(ram, 10)}`)}${fg(C.text)(` ${gib(stats.ramUsed)}/${gib(stats.ramTotal)} GB`)}${fg(C.dim)(g ? `    VRAM ${bar(g.used / g.total, 10)} ${gib(g.used)}/${gib(g.total)} GB` : "")}`
}

function layoutStatus(): void {
  const n = Math.max(1, Math.min(4, stats.gpus.length))
  sGpu.forEach((r, i) => (r.visible = i < n))
  logRows = Math.max(3, renderer.height - 4 - (5 + n))
  logView.height = logRows
}

function renderStatusPage(): void {
  const eng = enginePathAbs()
  const ok = !!eng && existsSync(eng)
  const label = (s: string) => fg(C.dim)(s.padEnd(9))
  sEngine.content = t`${label("engine")}${fg(ok ? C.ok : C.warn)(ok ? rel(eng) : "none selected — /releases to install, /use to pick")}${fg(C.dim)(ok && engineVer ? `  ${engineVer}` : "")}`
  sServer.content = server.running
    ? t`${label("server")}${fg(C.ok)("● running")}${fg(C.text)(`  pid ${server.pid}  ·  up ${formatDuration((Date.now() - server.startedAt) / 1000)}`)}${fg(C.accent)(server.url ? `  ·  ${server.url}` : "")}`
    : t`${label("server")}${fg(C.dim)("○ stopped  ·  /start launches it in the background")}`
  const lm = localModels()
  sModels.content = t`${label("models")}${fg(C.text)(`${lm.length} presets · ${lm.filter((m) => m.exists).length} on disk · ${formatBytes(lm.reduce((n, m) => n + m.size, 0))}`)}`
  const ram = stats.ramTotal ? stats.ramUsed / stats.ramTotal : 0
  sRam.content = t`${label("RAM")}${fg(usageColor(ram))(bar(ram, 24))}${fg(C.text)(` ${gib(stats.ramUsed)} / ${gib(stats.ramTotal)} GB  ${Math.round(ram * 100)}%`)}`
  sGpu.forEach((r, i) => {
    const g = stats.gpus[i]
    if (g) {
      const ratio = g.total ? g.used / g.total : 0
      r.content = t`${label(i === 0 ? "VRAM" : "")}${fg(usageColor(ratio))(bar(ratio, 24))}${fg(C.text)(` ${gib(g.used)} / ${gib(g.total)} GB  ${Math.round(ratio * 100)}%`)}${fg(C.dim)(`  ${truncate(g.name, 28)}`)}`
    } else if (i === 0) r.content = t`${label("VRAM")}${fg(C.dim)(stats.gpuNote || "n/a")}`
    else r.content = ""
  })
  const room = Math.max(20, renderer.width - 6)
  const end = Math.max(0, logLines.length - logScroll)
  const tail = logLines.slice(Math.max(0, end - logRows), end).map((l) => truncate(l.replace(/\t/g, "  "), room))
  sLogTitle.content = styled2(C.accent, `── logs · ${rel(LOG_FILE)} `, C.dim, logScroll > 0 ? `· ${logScroll} lines back (pgdn) ` : logLines.length ? "· following " : "· empty ")
  logView.content = tail.join("\n")
}

const HINT_IDLE = (): string => VIEWS[view].hint

function renderStatus(force = false): void {
  const spin = SPINNER[Math.floor(Date.now() / 90) % SPINNER.length] ?? "•"
  const room = Math.max(20, renderer.width - 6)
  let key: string
  let content: StyledText
  if (flashMsg && flashMsg.until > Date.now()) {
    key = `${flashMsg.tone}:${flashMsg.text}`
    content = styled1(TONE[flashMsg.tone], truncate(flashMsg.text, room))
  } else if (job && job.phase === "downloading") {
    const ratio = job.total > 0 ? Math.min(1, job.received / job.total) : 0
    const rate = (job.received - job.startBytes) / Math.max(0.001, (Date.now() - job.startedAt) / 1000)
    const eta = job.total > 0 && rate > 0 ? (job.total - job.received) / rate : 0
    const head = `${spin} ${bar(ratio, 16)} ${String(Math.floor(ratio * 100)).padStart(3)}%`
    const files = job.fileCount > 1 ? ` (${job.fileNo}/${job.fileCount})` : ""
    const tail = truncate(`  ${formatBytes(job.received)} / ${formatBytes(job.total)}  ${formatBytes(Math.max(0, rate))}/s  eta ${formatDuration(eta)}  ${job.title}${files}`, room - head.length)
    key = head + tail
    content = styled2(C.accent, head, C.dim, tail)
  } else if (job) {
    const head = `${spin} ${job.count ? `extracting ${job.done}/${job.count}` : "decompressing…"}`
    const tail = truncate(job.current ? `  ${job.current}` : "", room - head.length)
    key = head + tail
    content = styled2(C.accent, head, C.dim, tail)
  } else if (loading || hfLoading) {
    key = `${spin} loading…`
    content = styled1(C.accent, key)
  } else {
    key = HINT_IDLE()
    content = styled1(C.dim, truncate(key, room))
  }
  if (!force && key === lastStatus) return
  lastStatus = key
  statusLine.content = content
}

function onJobDone(): void {
  refreshList(true) // refreshes ✓ / ★ markers
  if (view === "welcome") renderDash()
  renderStatus(true)
}

// ──────────────────────────────────────── navigation ────────────────────────────────────────

function applyView(resetSelection = false): void {
  const def = VIEWS[view]
  welcome.visible = view === "welcome"
  list.visible = def.kind === "list"
  detail.visible = def.kind === "list" && !!def.detail
  notes.visible = def.kind === "notes"
  helpText.visible = def.kind === "help"
  statusBox.visible = def.kind === "status"
  header.visible = def.kind === "list" || def.kind === "notes" || def.kind === "help"
  if (def.kind === "list") refreshList(!resetSelection)
  else if (header.visible) renderHeader()
  if (view === "welcome") {
    layoutWelcome()
    refreshMenu()
    renderDash()
    animateBanner()
  }
  if (view === "status") {
    logScroll = 0
    layoutStatus()
    renderStatusPage()
  }
  renderStatus(true)
}

function go(next: View, keepInput = false): void {
  if (editing) endEdit()
  if (VIEWS[view].kind === "list" || view === "welcome") memory[view] = sel()
  if (TOP.includes(next)) stack = next === "welcome" ? [] : ["welcome"]
  else if (next !== view) stack.push(view)
  view = next
  if (!keepInput) {
    filter = ""
    setInputValue("", true)
  }
  hideDropdown()
  applyView(true)
  VIEWS[next].onEnter?.()
}

function goBack(): void {
  if (editing) return endEdit()
  const prev = stack.pop()
  if (!prev) return
  const keep = view === "notes" || view === "help"
  view = prev
  if (prev === "models") {
    filter = hfQuery // back from a repo: show the search that produced the list
    setInputValue(hfQuery, true)
  } else if (!keep) {
    filter = ""
    setInputValue("", true)
  }
  applyView(false)
  const mem = memory[prev]
  const i = mem === undefined ? -1 : shownRows.findIndex((r) => r.value === mem)
  if (!keep && i >= 0 && VIEWS[prev].kind === "list") {
    list.setSelectedIndex(i)
    updateDetail()
  }
  VIEWS[prev].onEnter?.()
}

function navigate(dir: 1 | -1, step: number, page: boolean): void {
  const def = VIEWS[view]
  if (def.kind === "notes") {
    if (page) notes.scrollBy(dir, "viewport")
    else notes.scrollBy(dir)
  } else if (def.kind === "status") {
    logScroll = Math.max(0, Math.min(Math.max(0, logLines.length - logRows), logScroll - dir * (page ? logRows - 1 : step)))
    renderStatusPage()
  } else if (def.kind === "list" || def.kind === "menu") {
    const l = def.kind === "menu" ? menu : list
    if (dir < 0) l.moveUp(step)
    else l.moveDown(step)
    updateDetail()
    if (dir > 0 && l === list && list.getSelectedIndex() >= shownRows.length - 1) def.atEnd?.()
  }
}

function activate(): void {
  const def = VIEWS[view]
  if (def.kind === "list" || def.kind === "menu") {
    const v = sel()
    if (v !== undefined) def.enter?.(v)
  } else if (def.kind === "notes" || def.kind === "help") goBack()
}

function secondary(): void {
  const def = VIEWS[view]
  if (def.kind === "notes" || def.kind === "help") return goBack()
  const v = sel()
  if (def.kind === "list" && def.tab && (v !== undefined || view === "artifacts")) def.tab(v)
}

function quit(code = 0): never {
  job?.abort.abort() // a running llama-server is deliberately left alone
  clearInterval(ticker)
  renderer.destroy()
  process.exit(code)
}

// ───────────────────────────────────── releases & notes ─────────────────────────────────────

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

function openRelease(r: Release): void {
  current = r
  go("artifacts")
}

function showNotes(title: string, sub: string, text: string): void {
  notesToken++
  notesTitle = title
  notesSub = sub
  notesText.content = text
  notes.scrollTo(0)
  go("notes", true)
}

const SCROLL_SUB = "↑↓ pgup/pgdn scroll · tab or esc to go back"
const releaseNotes = (r: Release): void =>
  showNotes(`Description · ${r.tag_name}`, `${releaseDate(r)} · ${SCROLL_SUB}`, cleanMarkdown(r.body ?? "") || "(this release has no description)")

// ───────────────────────────────── Hugging Face models & quants ─────────────────────────────────

async function loadModels(reset: boolean): Promise<void> {
  if (!reset && (!hfNext || hfLoading)) return reset ? undefined : flash("No more results")
  hfAbort?.abort()
  hfAbort = new AbortController()
  const seq = ++hfSeq
  hfLoading = true
  hfError = ""
  if (reset) {
    hfItems = []
    hfNext = null
    hfQuery = filter
  }
  refreshList(true)
  renderStatus(true)
  try {
    const { data, next } = await hfJson<HfModel[]>(reset ? hfListUrl(hfQuery, hfSort) : (hfNext ?? ""), hfAbort.signal)
    if (seq !== hfSeq) return
    const known = new Set(hfItems.map((m) => m.id))
    hfItems = hfItems.concat(data.filter((m) => !known.has(m.id)))
    hfNext = next
  } catch (err) {
    if (seq !== hfSeq || (err as Error).name === "AbortError") return
    hfError = errMsg(err)
    flash(hfError, "error", 12000)
  } finally {
    if (seq === hfSeq) {
      hfLoading = false
      refreshList(!reset)
      renderStatus(true)
    }
  }
}

async function openRepo(m: HfModel): Promise<void> {
  repo = m
  quants = []
  quantsState = "Loading files…"
  go("quants")
  try {
    const files = await hfFiles(m.id)
    if (repo !== m) return
    quants = groupQuants(files)
    quantsState = quants.length ? "" : "No .gguf files in this repository"
  } catch (err) {
    if (repo !== m) return
    quantsState = errMsg(err)
    flash(quantsState, "error", 12000)
  }
  if (view === "quants") refreshList(false)
}

function modelCard(m: HfModel): void {
  showNotes(`Model card · ${m.id}`, SCROLL_SUB, "Loading model card…")
  const token = notesToken
  fetch(`${HF}/${m.id}/raw/main/README.md`, { headers: hfHeaders() })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((md) => {
      if (token !== notesToken) return
      notesText.content = cleanMarkdown(md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")) || "(empty model card)"
    })
    .catch((err: unknown) => {
      if (token === notesToken) notesText.content = `Could not load the model card: ${errMsg(err)}`
    })
}

// ─────────────────────────────────── settings: config.ini / models.ini ───────────────────────────────────

const optionFor = (key: string): OptionInfo | undefined =>
  catalog?.find((o) => o.key === key || o.flags.some((f) => f.replace(/^-+/, "") === key))

const describe = (o?: OptionInfo): string =>
  o ? `${o.flags.join(", ")}${o.metavar ? ` ${o.metavar}` : ""} — ${o.desc}${o.env ? `  [env ${o.env}]` : ""}` : ""

async function ensureCatalog(force = false): Promise<void> {
  const dir = enginePathAbs()
  if (!dir || !existsSync(dir)) {
    catalog = null
    catalogState = "No engine selected — install one in /releases or pick it with /use, then options are read from `llama-server --help`"
    return refreshList(true)
  }
  if (!force && catalog && catalogFor === dir) return
  if (force) catalogCache.delete(dir)
  catalog = null
  catalogFor = dir
  catalogState = "Reading options from `llama-server --help`…"
  refreshList(true)
  try {
    catalog = await loadCatalog(dir)
    catalogState = ""
  } catch (err) {
    catalogState = errMsg(err)
  }
  refreshList(true)
}

/** Writes key=value into a models.ini section ("" removes the key); an existing alias (e.g. `c` for ctx-size) is edited in place. */
function setModelsKey(section: string, key: string, value: string, aliases: string[] = [key]): void {
  const ini = iniLoad(modelsIniPath())
  const existing = iniFindKey(ini, section, aliases) ?? key
  if (value.trim() === "") {
    iniUnset(ini, section, existing)
    flash(`[${section}] ${existing} removed`, "ok")
  } else {
    iniSet(ini, section, existing, value.trim())
    flash(`[${section}] ${existing} = ${value.trim()}`, "ok")
  }
  iniSave(ini)
  refreshList(true)
}

function beginEdit(label: string, hint: string, initial: string, choices: () => string[], commit: (v: string) => void): void {
  editing = { label, choices, pristine: true, commit }
  prompt.content = `${label} = `
  prompt.width = label.length + 4
  setInputValue(initial, true)
  flash(hint, "info", 60000)
  updateDropdown(initial)
}

function endEdit(): void {
  editing = null
  prompt.content = "> "
  prompt.width = 2
  setInputValue("", true)
  hideDropdown()
  flashMsg = null
  renderStatus(true)
}

function commitEdit(value: string): void {
  const done = editing?.commit
  endEdit()
  done?.(value)
}

function editKey(k: { key: string; value: string }): void {
  const o = optionFor(k.key)
  if (o?.boolean) return setModelsKey(cfgSection, k.key, isOn(k.value) ? "0" : "1")
  beginEdit(k.key, `${describe(o) || "free-form value"} · empty removes the key`, k.value, () => o?.choices ?? [], (v) => setModelsKey(cfgSection, k.key, v))
}

function addOption(o: OptionInfo): void {
  const aliases = o.flags.map((f) => f.replace(/^-+/, ""))
  const ini = iniLoad(modelsIniPath())
  const existing = iniFindKey(ini, cfgSection, aliases)
  const cur = existing ? (iniGet(ini, cfgSection, existing) ?? "") : ""
  if (o.boolean) {
    setModelsKey(cfgSection, o.key, existing ? (isOn(cur) ? "0" : "1") : "1", aliases)
    return goBack()
  }
  beginEdit(o.key, `${describe(o)} · empty removes the key`, cur, () => o.choices, (v) => {
    setModelsKey(cfgSection, o.key, v, aliases)
    goBack()
  })
}

function editManager(k: CfgKey): void {
  beginEdit(k.key, `${k.desc} · empty = default (${k.def || "none"})`, cfgGet(k.key), k.choices ?? (() => []), (v) => {
    cfgSet(k.key, v)
    if (k.key === "engine-path") void refreshEngineVer()
    flash(v.trim() ? `${k.key} = ${v.trim()}` : `${k.key} reset to default`, "ok")
    refreshList(true)
  })
}

async function refreshEngineVer(): Promise<void> {
  const dir = enginePathAbs()
  engineVer = dir && existsSync(dir) ? await engineVersion(dir) : ""
  if (view === "welcome") renderDash()
  else if (view === "status") renderStatusPage()
}

// ────────────────────────────────────────── view table ──────────────────────────────────────────

function modelColumns(): number {
  return Math.max(20, listWidth() - 30)
}

const VIEWS: Record<View, ViewDef> = {
  welcome: {
    kind: "menu",
    hint: "↑↓ move · enter open · / for commands",
    title: () => "",
    sub: () => "",
    enter: (v: string) => runNamed(v),
    onEnter: () => {
      void refreshEngineVer()
      void sampleStats().then(() => view === "welcome" && renderDash())
    },
  },

  releases: {
    kind: "list",
    filter: "local",
    hint: "↑↓ move · enter open · tab notes · type to filter · / commands · esc home",
    title: () => `Releases · ${REPO}`,
    sub: (n) => (filter ? `${n.shown} of ${n.total} match “${filter}”` : `${n.total} loaded${hasMore ? " · /more for older" : ""}`),
    rows: () =>
      releases.map((r) => {
        const head = `${r.tag_name.padEnd(8)} ${releaseDate(r)}  ${r.prerelease ? "[pre] " : ""}`
        const title = firstLine(r.body)
        return { label: head + truncate(title, listWidth() - head.length), value: r, search: `${r.tag_name} ${r.name ?? ""} ${releaseDate(r)} ${title}` }
      }),
    empty: () => (loading ? "Loading releases…" : loadError || (releases.length ? "No release matches your filter" : "Nothing loaded — try /refresh")),
    enter: (r: Release) => openRelease(r),
    tab: (r: Release) => releaseNotes(r),
    atEnd: () => {
      if (hasMore && !loading && !filter) void loadReleases()
    },
    onEnter: () => {
      if (releases.length === 0 && !loading) void loadReleases()
    },
  },

  artifacts: {
    kind: "list",
    filter: "local",
    hint: "↑↓ move · enter download · tab notes · /use engine · type to filter · esc back",
    title: () => (current ? `${current.tag_name} · ${releaseDate(current)}` : "Artifacts"),
    sub: (n) => (filter ? `${n.shown} of ${n.total} artifacts match “${filter}”` : `${n.total} artifacts · enter downloads + extracts to ${rel(ENGINES_DIR)}/   ✓ installed  ★ engine in use`),
    rows: () => {
      const assets = current ? [...current.assets].sort((a, b) => a.name.localeCompare(b.name)) : []
      const nameW = Math.min(assets.reduce((m, a) => Math.max(m, a.name.length), 0), Math.max(20, listWidth() - 14))
      const inUse = enginePathAbs()
      return assets.map((a) => {
        const dir = join(ENGINES_DIR, stripArchiveExt(a.name))
        const mark = dir === inUse ? "★" : existsSync(dir) ? "✓" : " "
        return { label: `${mark} ${truncate(a.name, nameW).padEnd(nameW)}  ${formatBytes(a.size).padStart(8)}`, value: a, search: a.name }
      })
    },
    empty: () => "No artifact matches your filter",
    enter: (a: Asset) => void installArtifact(a),
    tab: () => current && releaseNotes(current),
  },

  models: {
    kind: "list",
    filter: "remote",
    hint: "↑↓ move · enter quants · tab model card · type to search · /sort · /more · esc home",
    title: () => "Hugging Face · GGUF models",
    sub: () => `sorted by ${SORTS[hfSort].label} · ${hfItems.length} loaded${hfNext ? " · /more for more" : ""}${hfQuery ? ` · search “${hfQuery}”` : ""}`,
    rows: () => {
      const w = modelColumns()
      return hfItems.map((m) => ({
        label: `${truncate(m.id, w).padEnd(w)}  ${`↓${compact(m.downloads)}`.padStart(7)} ${`♥${compact(m.likes)}`.padStart(6)}  ${ago(hfSort === "created" ? m.createdAt : m.lastModified).padStart(4)}${m.gated ? " gated" : ""}`,
        value: m,
      }))
    },
    empty: () => (hfLoading ? "Searching Hugging Face…" : hfError || "No GGUF models found"),
    enter: (m: HfModel) => void openRepo(m),
    tab: (m: HfModel) => modelCard(m),
    atEnd: () => {
      if (hfNext && !hfLoading) void loadModels(false)
    },
    onEnter: () => {
      if ((hfItems.length === 0 || hfQuery !== filter) && !hfLoading) void loadModels(true)
    },
  },

  quants: {
    kind: "list",
    filter: "local",
    hint: "↑↓ move · enter download · tab model card · type to filter · esc back",
    title: () => repo?.id ?? "Quantizations",
    sub: (n) =>
      filter
        ? `${n.shown} of ${n.total} files match “${filter}”`
        : `${n.total} GGUF files · enter downloads to ${rel(modelsDir())}/ and registers it in ${basename(modelsIniPath())}   ✓ downloaded`,
    rows: () => {
      const w = Math.max(16, listWidth() - 38)
      return quants.map((q) => {
        const first = q.files[0]?.path ?? ""
        const have = existsSync(join(q.mmproj ? mmprojDir() : modelsDir(), basename(first)))
        const parts = q.files.length > 1 ? `  ${q.files.length} parts` : ""
        return { label: `${have ? "✓" : " "} ${truncate(q.label, 18).padEnd(18)} ${formatBytes(q.size).padStart(9)}  ${truncate(basename(first) + parts, w)}`, value: q, search: `${q.label} ${first}` }
      })
    },
    empty: () => quantsState || "No file matches your filter",
    enter: (q: Quant) => repo && void downloadQuant(repo.id, q, quants),
    tab: () => repo && modelCard(repo),
  },

  installed: {
    kind: "list",
    filter: "local",
    hint: "↑↓ move · enter edit options · /remove deletes · type to filter · esc home",
    title: () => "Downloaded models",
    sub: (n) => (filter ? `${n.shown} of ${n.total} match “${filter}”` : `${n.total} presets in ${rel(modelsIniPath())} · ✓ files present  ✗ missing`),
    rows: () => {
      const all = localModels()
      const w = Math.min(36, all.reduce((m, x) => Math.max(m, x.name.length), 8))
      return all.map((m) => ({
        label: `${m.exists ? "✓" : "✗"} ${truncate(m.name, w).padEnd(w)}  ${formatBytes(m.size).padStart(9)}  ${truncate(m.model || "(no model path)", Math.max(10, listWidth() - w - 18))}`,
        value: m,
        search: `${m.name} ${m.model}`,
      }))
    },
    empty: () => `No models yet — use /models to download one (entries live in ${basename(modelsIniPath())})`,
    detail: (m: Local) => `${m.files.length} file(s)${m.mmproj ? ` · mmproj ${m.mmproj}` : ""} · enter edits its llama-server options · /remove deletes the files and the entry`,
    enter: (m: Local) => {
      cfgSection = m.name
      go("cfg-section")
    },
  },

  settings: {
    kind: "list",
    hint: "↑↓ move · enter open · esc home",
    title: () => "Settings",
    sub: () => `engine: ${cfgGet("engine-path") || "none selected"}`,
    rows: () => [
      { label: "Manager configuration     config.ini · engine path, folders, extra server args", value: "cfg-manager" },
      { label: "Engine configuration      models.ini · llama-server presets and options", value: "cfg-sections" },
    ],
    enter: (v: View) => go(v),
  },

  "cfg-manager": {
    kind: "list",
    hint: "↑↓ move · enter edit · empty value = default · esc back",
    title: () => `Manager configuration · ${rel(CONFIG_INI)}`,
    sub: () => "values are stored in the [*] section; relative paths are resolved from where the manager runs",
    rows: () =>
      MANAGER_KEYS.map((k) => {
        const v = iniGet(iniLoad(CONFIG_INI), "*", k.key)
        return { label: `${k.key.padEnd(16)} ${v ?? `(default: ${k.def || "none"})`}`, value: k }
      }),
    detail: (k: CfgKey) => k.desc,
    enter: (k: CfgKey) => editManager(k),
  },

  "cfg-sections": {
    kind: "list",
    filter: "local",
    hint: "↑↓ move · enter open · type to filter · esc back",
    title: () => `Engine configuration · ${rel(modelsIniPath())}`,
    sub: (n) => (filter ? `${n.shown} of ${n.total} sections match “${filter}”` : "[*] applies to every model · other sections are model presets"),
    rows: () => {
      const ini = iniLoad(modelsIniPath())
      const names = ["*", ...iniSections(ini).map((s) => s.name).filter((n) => n !== "*")]
      return names.map((name) => ({
        label: `${name === "*" ? "[*]  defaults for every model" : `[${name}]`}   ·  ${iniKeys(ini, name).length} options`,
        value: name,
        search: name,
      }))
    },
    enter: (name: string) => {
      cfgSection = name
      go("cfg-section")
    },
  },

  "cfg-section": {
    kind: "list",
    hint: "↑↓ move · enter edit/toggle · empty value removes · esc back",
    title: () => `${rel(modelsIniPath())} · [${cfgSection}]`,
    sub: () => catalogState || (catalog ? `${catalog.length} options known from \`llama-server --help\`` : ""),
    rows: () => {
      const kvs = iniKeys(iniLoad(modelsIniPath()), cfgSection)
      const w = Math.min(28, kvs.reduce((m, k) => Math.max(m, k.key.length), 10))
      const rows: Row[] = kvs.map((k) => ({
        label: truncate(`${k.key.padEnd(w)} = ${k.value}${optionFor(k.key) ? `   ${optionFor(k.key)?.desc}` : ""}`, listWidth()),
        value: { key: k.key, value: k.value },
      }))
      rows.push({ label: "+ add option…", value: "ADD" })
      return rows
    },
    detail: (v: { key: string; value: string } | "ADD") => (v === "ADD" ? "Pick any option the engine reports in `llama-server --help`." : describe(optionFor(v.key))),
    enter: (v: { key: string; value: string } | "ADD") => (v === "ADD" ? go("cfg-catalog") : editKey(v)),
    onEnter: () => void ensureCatalog(),
  },

  "cfg-catalog": {
    kind: "list",
    filter: "local",
    hint: "type to filter options · ↑↓ move · enter add/edit · esc back",
    title: () => `Add option to [${cfgSection}]`,
    sub: (n) => catalogState || (filter ? `${n.shown} of ${n.total} options match “${filter}”` : `${n.total} options from \`llama-server --help\` (not hard-coded: they follow the selected engine)`),
    rows: () => {
      const all = catalog ?? []
      const kw = Math.min(26, all.reduce((m, o) => Math.max(m, o.key.length), 8))
      const mw = Math.min(14, all.reduce((m, o) => Math.max(m, o.metavar.length), 6))
      return all.map((o) => ({
        label: truncate(`${o.key.padEnd(kw)} ${(o.metavar || "flag").padEnd(mw)} ${o.desc}`, listWidth()),
        value: o,
        search: `${o.key} ${o.flags.join(" ")} ${o.desc} ${o.group}`,
      }))
    },
    empty: () => catalogState || "No option matches your filter",
    detail: (o: OptionInfo) => `${describe(o)}${o.def ? `  (default: ${o.def})` : ""}`,
    enter: (o: OptionInfo) => addOption(o),
    onEnter: () => void ensureCatalog(),
  },

  notes: { kind: "notes", hint: "↑↓ pgup/pgdn scroll · tab or esc to go back", title: () => notesTitle, sub: () => notesSub },
  status: { kind: "status", hint: "pgup/pgdn scroll logs · /start /stop · esc home", title: () => "Status", sub: () => "" },
  help: { kind: "help", hint: "esc to go back", title: () => "Help", sub: () => "commands and keys" },
}

// ───────────────────────────────────────── commands ─────────────────────────────────────────

function runNamed(name: string): void {
  const c = COMMANDS.find((x) => x.name === name)
  if (c) runCommand(c, "")
}

async function openCmd(arg: string): Promise<void> {
  const a = arg.trim()
  if (!a) return flash("Usage: /open <release tag>  or  /open <owner/repo> for Hugging Face", "warn")
  if (/^[\w.-]+\/[\w.-]+$/.test(a)) return openRepo({ id: a, likes: 0, downloads: 0 })
  const tag = /^\d+$/.test(a) ? `b${a}` : a
  const known = releases.find((r) => r.tag_name.toLowerCase() === tag.toLowerCase())
  if (known) return openRelease(known)
  flash(`Fetching ${tag}…`)
  openRelease(await ghFetch<Release>(`/releases/tags/${encodeURIComponent(tag)}`))
}

function useCmd(arg: string): void {
  const engines = installedEngines()
  let name = arg.trim().replace(/\\/g, "/").replace(/^\.?\/?engines\//, "")
  if (!name && view === "artifacts") {
    const a = sel() as Asset | undefined
    name = a ? stripArchiveExt(a.name) : ""
  }
  if (!name) return flash(`Usage: /use <engine>   installed: ${engines.join(", ") || "none"}`, "warn")
  const hit = engines.find((e) => e === name) ?? engines.find((e) => e.toLowerCase().includes(name.toLowerCase()))
  if (!hit) return flash(`“${name}” is not installed in ${rel(ENGINES_DIR)}`, "warn")
  cfgSet("engine-path", engineRel(hit))
  catalog = null
  void refreshEngineVer()
  refreshList(true)
  flash(`Engine → ${engineRel(hit)}`, "ok")
}

function sortCmd(arg: string): void {
  const k = SORT_KEYS.find((s) => s === arg.trim().toLowerCase())
  if (!k) return flash(`Usage: /sort <${SORT_KEYS.join("|")}>`, "warn")
  hfSort = k
  hfItems = []
  hfNext = null
  if (view === "models") void loadModels(true)
  else go("models")
}

function downloadCmd(): void {
  const v = sel()
  if (view === "artifacts" && v) void installArtifact(v as Asset)
  else if (view === "quants" && v && repo) void downloadQuant(repo.id, v as Quant, quants)
  else flash("Highlight an artifact (/releases) or a quantization (/models) first", "warn")
}

function removeCmd(): void {
  const m = view === "installed" ? (sel() as Local | undefined) : undefined
  if (!m) return flash("Open /installed and highlight a model first", "warn")
  if (!armed || armed.name !== m.name || armed.until < Date.now()) {
    armed = { name: m.name, until: Date.now() + 10000 }
    return flash(`Delete ${m.name} (${formatBytes(m.size)}) and its models.ini entry?  Run /remove again within 10s to confirm`, "warn", 10000)
  }
  armed = null
  flash(removeLocal(m), "ok", 10000)
  refreshList(true)
}

async function serverCmd(action: "start" | "stop" | "restart"): Promise<void> {
  try {
    if (action !== "start") {
      flash("Stopping llama-server…")
      const msg = await stopServer()
      if (action === "stop") flash(msg, msg.includes("not running") ? "info" : "ok")
    }
    if (action !== "stop") {
      flash("Starting llama-server…")
      flash(await startServer(), "ok", 10000)
    }
  } catch (err) {
    flash(errMsg(err), "error", 15000)
  }
  await refreshServer()
  if (view === "welcome") {
    refreshMenu()
    renderDash()
  } else if (view === "status") renderStatusPage()
}

function moreCmd(): void {
  if (view === "models") void loadModels(false)
  else if (view === "releases" || view === "artifacts") void loadReleases()
  else flash("Nothing to load more of here", "info")
}

function refreshCmd(): void {
  if (view === "releases" || view === "artifacts") void loadReleases(true)
  else if (view === "models") void loadModels(true)
  else if (view === "quants" && repo) void openRepo(repo)
  else if (view === "cfg-section" || view === "cfg-catalog") void ensureCatalog(true)
  else if (view === "status") void sampleStats().then(() => renderStatusPage())
  else refreshList(true)
}

const COMMANDS: Command[] = [
  { name: "welcome", aliases: ["home"], desc: "Welcome screen", run: () => go("welcome") },
  { name: "releases", aliases: ["r"], desc: "Browse llama.cpp releases · install engines", run: () => go("releases") },
  { name: "models", aliases: ["m"], desc: "Search Hugging Face GGUF models · download", run: () => go("models") },
  { name: "installed", aliases: ["local"], desc: "Downloaded models (models.ini)", run: () => go("installed") },
  { name: "settings", aliases: ["s"], desc: "config.ini and models.ini editor", run: () => go("settings") },
  { name: "status", desc: "Server logs · DRAM / VRAM", run: () => go("status") },
  { name: "start", desc: "Start llama-server in the background", run: () => serverCmd("start") },
  { name: "stop", desc: "Stop the background llama-server", run: () => serverCmd("stop") },
  { name: "restart", desc: "Restart llama-server", run: () => serverCmd("restart") },
  {
    name: "use",
    args: "[engine]",
    desc: "Select the engine used by /start",
    complete: (a) => installedEngines().filter((e) => e.toLowerCase().includes(a.trim().toLowerCase())),
    run: useCmd,
  },
  { name: "open", args: "<tag|owner/repo>", desc: "Open a release tag or a Hugging Face repo", run: openCmd },
  {
    name: "sort",
    args: "<mode>",
    desc: "Sort Hugging Face models",
    complete: (a) => SORT_KEYS.filter((k) => k.startsWith(a.trim().toLowerCase())),
    run: sortCmd,
  },
  {
    name: "notes",
    aliases: ["n", "card"],
    desc: "Release notes / model card",
    run: () => {
      if (view === "releases" || view === "models" || view === "artifacts" || view === "quants") secondary()
      else flash("Notes are available on /releases and /models", "info")
    },
  },
  { name: "download", aliases: ["dl"], desc: "Download the highlighted artifact / quant", run: downloadCmd },
  { name: "remove", aliases: ["rm"], desc: "Delete the highlighted downloaded model", run: removeCmd },
  { name: "cancel", desc: "Cancel the running download", run: () => (job ? job.abort.abort() : flash("No download is running")) },
  { name: "more", desc: "Load more results", run: moreCmd },
  { name: "refresh", aliases: ["reload"], desc: "Reload the current page", run: refreshCmd },
  { name: "back", aliases: ["b"], desc: "Go back", run: goBack },
  { name: "help", aliases: ["h", "?"], desc: "Commands and keys", run: () => go("help", true) },
  { name: "quit", aliases: ["q", "exit"], desc: "Exit (a running server keeps running)", run: () => quit() },
]

const findCommand = (name: string): Command | undefined =>
  COMMANDS.find((c) => c.name === name.toLowerCase() || c.aliases?.includes(name.toLowerCase()))

function runCommand(cmd: Command, arg: string): void {
  Promise.resolve()
    .then(() => cmd.run(arg))
    .catch((err: unknown) => flash(errMsg(err), "error", 10000))
}

function runCommandLine(line: string): void {
  const sp = line.indexOf(" ")
  const name = (sp < 0 ? line.slice(1) : line.slice(1, sp)).toLowerCase()
  const byPrefix = COMMANDS.filter((c) => c.name.startsWith(name))
  const cmd = findCommand(name) ?? (byPrefix.length === 1 ? byPrefix[0] : undefined)
  if (!cmd) return flash(`Unknown command “/${name}” — type / to see all commands`, "warn")
  runCommand(cmd, sp < 0 ? "" : line.slice(sp + 1).trim())
}

function helpContent(): string {
  const cmds = COMMANDS.map((c) => {
    const usage = `/${c.name}${c.args ? ` ${c.args}` : ""}`
    const alias = c.aliases?.length ? `  (${c.aliases.map((a) => `/${a}`).join(" ")})` : ""
    return `  ${usage.padEnd(24)}${c.desc}${alias}`
  })
  return [
    "Commands",
    ...cmds,
    "",
    "Keys",
    "  ↑ ↓  pgup pgdn   move · scroll (shift+↑↓ moves 5 rows)",
    "  enter            open · download · edit · toggle        tab   description / model card",
    "  esc              close dropdown → cancel edit → clear input → go back",
    "  ctrl+c           quit (the server keeps running)",
    "",
    "Filtering   type text without a leading / — words are ANDed (e.g. win cuda x64). On /models it searches Hugging Face.",
    `Files       engines → ${rel(ENGINES_DIR)}/<artifact>/ · models → ${rel(modelsDir())}/ · logs → ${rel(LOG_FILE)} · presets → ${rel(modelsIniPath())}`,
    GITHUB_TOKEN ? "GitHub      authenticated (GITHUB_TOKEN)" : "GitHub      anonymous, 60 requests/hour — set GITHUB_TOKEN to lift the limit",
    HF_TOKEN ? "Hugging Face authenticated (HF_TOKEN)" : "Hugging Face anonymous — set HF_TOKEN for gated repos",
  ].join("\n")
}

// ──────────────────────────────────── input line & dropdown ────────────────────────────────────

/** Sets the input text and parks the cursor at its end; quiet = don't run the INPUT handler. */
function setInputValue(text: string, quiet = false): void {
  silent = quiet
  try {
    input.value = text
  } finally {
    silent = false
  }
  const c = input as unknown as { cursorPosition?: number; cursorOffset?: number }
  try {
    if (typeof c.cursorPosition === "number") c.cursorPosition = text.length
    else if (typeof c.cursorOffset === "number") c.cursorOffset = text.length
  } catch {
    // read-only on some versions: the cursor stays where the library put it
  }
}

const commandLabel = (c: Command): string => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(22)} ${c.desc}`

function hideDropdown(): void {
  dropdown.visible = false
  suggestions = []
}

function updateDropdown(value: string): void {
  if (dismissed) return hideDropdown()
  let found: Sugg[] = []
  if (editing) {
    const q = value.toLowerCase()
    const all = editing.choices()
    found = (editing.pristine || !q ? all : all.filter((c) => c.toLowerCase().includes(q))).map((c) => ({ label: c, insert: c }))
  } else if (value.startsWith("/")) {
    const sp = value.indexOf(" ")
    if (sp < 0) {
      const token = value.slice(1).toLowerCase()
      found = COMMANDS.filter((c) => c.name.startsWith(token) || c.aliases?.some((a) => a.startsWith(token)))
        .sort((a, b) => Number(b.name.startsWith(token)) - Number(a.name.startsWith(token)))
        .map((c) => ({ label: commandLabel(c), insert: `/${c.name} `, cmd: c }))
    } else {
      const cmd = findCommand(value.slice(1, sp))
      found = (cmd?.complete?.(value.slice(sp + 1)) ?? []).map((a) => ({ label: a, insert: `/${cmd?.name} ${a}`, cmd, arg: a }))
    }
  }
  if (found.length === 0) return hideDropdown()
  suggestions = found
  dropdownList.options = found.map((s) => ({ name: s.label, description: "", value: s }))
  dropdownList.setSelectedIndex(0)
  dropdown.height = Math.min(found.length, 8) + 2
  dropdown.visible = true
}

function acceptSuggestion(complete: boolean): void {
  const s = suggestions[dropdownList.getSelectedIndex()]
  if (!s) return
  if (editing) {
    if (complete) {
      setInputValue(s.insert)
      return
    }
    return commitEdit(s.insert)
  }
  const token = input.value.slice(1).toLowerCase()
  const exact = s.cmd && (token === s.cmd.name || (s.cmd.aliases?.includes(token) ?? false))
  if (!complete && s.cmd && (s.arg !== undefined || exact || !s.cmd.args)) {
    setInputValue("", true)
    hideDropdown()
    runCommand(s.cmd, s.arg ?? "")
  } else setInputValue(s.insert)
}

input.on(InputRenderableEvents.INPUT, (value: string) => {
  if (silent) return
  dismissed = false
  if (editing) {
    editing.pristine = false
    return updateDropdown(value)
  }
  const onFilterChanged = (): void => {
    if (VIEWS[view].filter === "remote") {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void loadModels(true), 350)
    } else refreshList()
  }
  if (value.startsWith("/")) {
    if (filter) {
      filter = ""
      onFilterChanged()
    }
    return updateDropdown(value)
  }
  hideDropdown()
  if (value.trim() !== filter) {
    filter = value.trim()
    onFilterChanged()
  }
})

function onEnter(): void {
  if (dropdown.visible) return acceptSuggestion(false)
  if (editing) return commitEdit(input.value)
  const value = input.value
  if (!value.startsWith("/")) return activate()
  setInputValue("", true)
  runCommandLine(value)
}

function onEscape(): void {
  if (dropdown.visible) {
    dismissed = true
    hideDropdown()
  } else if (editing) endEdit()
  else if (input.value) {
    setInputValue("", true)
    if (filter) {
      filter = ""
      if (VIEWS[view].filter === "remote") void loadModels(true)
      else refreshList()
    }
  } else goBack()
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
      } else navigate(dir, page ? 10 : key.shift ? 5 : 1, page)
      return
    }
    case "tab":
      key.preventDefault()
      if (dropdown.visible) acceptSuggestion(true)
      else secondary()
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

function onTick(): void {
  tickCount++
  renderStatus()
  if (view === "welcome" && tickCount % 2 === 0) animateBanner()
  if (tickCount % 10 === 0) {
    const fresh = pollLog()
    void refreshServer()
      .then(() => {
        if (view === "welcome" && menuRunning !== server.running) refreshMenu()
        if (view === "welcome") renderDash()
        else if (view === "status" && (fresh || tickCount % 10 === 0)) renderStatusPage()
      })
      .catch(() => undefined)
  }
  if (tickCount % 20 === 0 && (view === "welcome" || view === "status")) {
    void sampleStats()
      .then(() => {
        if (view === "welcome") renderDash()
        else if (view === "status") {
          layoutStatus()
          renderStatusPage()
        }
      })
      .catch(() => undefined)
  }
}

const ticker = setInterval(onTick, 100) // spinner · progress · banner · server/log/memory polling
renderer.on("resize", () => {
  if (view === "welcome") layoutWelcome()
  if (view === "status") layoutStatus()
  applyView(false)
})
renderer.once("destroy", () => {
  clearInterval(ticker)
  job?.abort.abort()
})

helpText.content = helpContent()
pollLog()
void refreshServer().then(() => view === "welcome" && (refreshMenu(), renderDash()))
applyView(true)
VIEWS.welcome.onEnter?.()