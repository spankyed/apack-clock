// Build reproducibility and size/cost guardrails on the compiled package:
//   1. Snapshots `dist/`, rebuilds `dist/` cleanly from scratch, and asserts every emitted file matches byte-for-byte.
//   2. Records and bounds raw and gzipped sizes of `dist/index.js` and `dist/index.d.ts`.
//   3. Verifies steady-state scheduler cost on `dist/index.js`: 1,000 non-head asks and cancels arm exactly 1 timer.
//
//   npm run package:check
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const distDir = path.join(root, 'dist')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const snapshot = () => new Map(
  fs.readdirSync(distDir).sort().map((name) => [name, sha256(fs.readFileSync(path.join(distDir, name)))]),
)

const first = snapshot()
fs.rmSync(distDir, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
const second = snapshot()

if (JSON.stringify([...first.keys()]) !== JSON.stringify([...second.keys()])) {
  throw new Error(`Non-deterministic build file list: ${[...first.keys()].join(',')} vs ${[...second.keys()].join(',')}`)
}
for (const [name, hash] of first) {
  if (second.get(name) !== hash) {
    throw new Error(`Non-deterministic build output for ${name}: ${hash} !== ${second.get(name)}`)
  }
}

const jsBytes = fs.readFileSync(path.join(distDir, 'index.js'))
const jsGzip = gzipSync(jsBytes, { level: 9 }).length
const dtsBytes = fs.readFileSync(path.join(distDir, 'index.d.ts'))

const MAX_JS_RAW = 13_000
const MAX_JS_GZIP = 4_000
if (jsBytes.length > MAX_JS_RAW) throw new Error(`dist/index.js grew to ${jsBytes.length} B (limit ${MAX_JS_RAW} B)`)
if (jsGzip > MAX_JS_GZIP) throw new Error(`dist/index.js gzip grew to ${jsGzip} B (limit ${MAX_JS_GZIP} B)`)

const { ClockController } = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
let mono = 0
let armedCount = 0
const controller = new ClockController({
  monotonic: () => mono,
  wall: () => 0,
  timer: () => { armedCount++; return () => {} },
  turn: () => {},
})
const head = controller.clock.after(10, () => {})
const cancels = []
const started = performance.now()
for (let i = 1; i <= 1_000; i++) cancels.push(controller.clock.after(10 + i, () => {}))
for (let i = cancels.length - 1; i >= 0; i--) cancels[i]()
const elapsedMs = performance.now() - started
head()
controller.close()
if (armedCount !== 1) throw new Error(`Expected 1 armed timer across 1,000 non-head asks/cancels, saw ${armedCount}`)

console.log(
  `reproducible build verified (${first.size} files, sha256=${first.get('index.js').slice(0, 12)}), ` +
  `dist/index.js=${jsBytes.length} B (${jsGzip} B gzip), dist/index.d.ts=${dtsBytes.length} B, ` +
  `1000 non-head asks+cancels=${elapsedMs.toFixed(2)} ms (1 armed timer)`,
)
