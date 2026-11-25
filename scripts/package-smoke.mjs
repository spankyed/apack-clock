// The package as a consumer gets it: packed, installed into a project of its own, imported by its name, typechecked
// against TS 5.7 under both browser ES2023+DOM (`types: []`) and Node ES2023 (`apack-link`/`apack-state` shape) with
// `skipLibCheck: false`, and the README's example run there. Removes what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, cwd) => execFileSync(npm, args.map((arg) => (process.platform === 'win32' && /\s/.test(arg) ? `"${arg}"` : arg)), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-clock-consumer-'))
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], root))
    tarball = path.join(consumer, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer)
  fs.writeFileSync(path.join(consumer, 'entries.mjs'), `
import * as clock from '@apackdev/clock'
import * as testing from '@apackdev/clock/testing'
for (const name of ['ClockController', 'ClockClosedError']) if (typeof clock[name] !== 'function') throw new Error('@apackdev/clock has no ' + name)
if (clock.MAX_TIMER_MS !== 0x7fffffff) throw new Error('@apackdev/clock has no MAX_TIMER_MS')
if (typeof testing.TestClock !== 'function') throw new Error('@apackdev/clock/testing has no TestClock')
const tc = new testing.TestClock()
let woke = false
const done = tc.clock.sleep(10).then(() => { woke = true })
await tc.advance(10)
await done
tc.close()
if (!woke) throw new Error('@apackdev/clock/testing TestClock failed to wake sleep')
`)
  execFileSync(process.execPath, ['entries.mjs'], { cwd: consumer, stdio: 'inherit' })
  fs.writeFileSync(path.join(consumer, 'consumer.ts'), `
import {
  ClockController,
  ClockClosedError,
  MAX_TIMER_MS,
  type Clock,
  type ClockSleepOptions,
  type ClockSources,
} from '@apackdev/clock'
import { TestClock, type TestClockOptions } from '@apackdev/clock/testing'

const minimal: Clock = { now: () => 0, after: () => () => {}, sleep: async () => {} }
const controller = new ClockController()
const handoff: Clock = controller.clock
// @ts-expect-error ClockController must not be assignable to Clock.
const leaked: Clock = controller
// @ts-expect-error Consumer Clock must not expose host close().
void handoff.close
// @ts-expect-error Consumer Clock must not expose host suspend().
void handoff.suspend
const opts: ClockSleepOptions = {}
const partial: Partial<ClockSources> = {}
const tcOpts: TestClockOptions = { wall: 1000, maxSteps: 100 }
const tc = new TestClock(tcOpts)
const testHandoff: Clock = tc.clock
const elapsedMs: number = tc.elapsed()
// @ts-expect-error TestClock must not be assignable to Clock.
const leakedTest: Clock = tc
void minimal
void leaked
void opts
void partial
void testHandoff
void elapsedMs
void leakedTest
void ClockClosedError
void MAX_TIMER_MS
`)
  const tsc57 = path.join(root, 'node_modules', 'typescript-5.7', 'bin', 'tsc')
  // 1. Browser ES2023+DOM consumer (`types: []`, no `ESNext.Disposable`, `skipLibCheck: false`): proves dist/index.d.ts
  //    leaks neither Node-only types nor `ESNext.Disposable`.
  fs.writeFileSync(path.join(consumer, 'tsconfig.browser.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023', 'DOM'],
      types: [],
      noEmit: true,
      strict: true,
      skipLibCheck: false,
    },
    include: ['consumer.ts'],
  }))
  execFileSync(process.execPath, [tsc57, '--noEmit', '-p', 'tsconfig.browser.json'], { cwd: consumer, stdio: 'inherit' })
  // 2. Node ES2023 consumer (matches `apack-link` and `apack-state`: `lib: ["ES2023"]`, `types: ["node"]`, no `ESNext.Disposable`).
  fs.writeFileSync(path.join(consumer, 'tsconfig.node.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023'],
      types: ['node'],
      typeRoots: [path.join(root, 'node_modules', '@types')],
      noEmit: true,
      strict: true,
      skipLibCheck: false,
    },
    include: ['consumer.ts'],
  }))
  execFileSync(process.execPath, [tsc57, '--noEmit', '-p', 'tsconfig.node.json'], { cwd: consumer, stdio: 'inherit' })
  // The README's first example, as it is written there, run with its types stripped: it logs what ran, in order.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  const example = /```ts\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!example) throw new Error('The README has no ts example')
  fs.writeFileSync(path.join(consumer, 'example.mts'), example)
  const logged = execFileSync(process.execPath, ['example.mts'], { cwd: consumer, encoding: 'utf8' })
  const said = /```text\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!said || logged.trim() !== said.trim()) throw new Error(`The README example logged ${logged}, and the README says ${said}`)
  console.log('the entry loaded, TS 5.7 ES2023 browser and Node consumers typechecked, and the README example logged what the README says it does')
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
}
