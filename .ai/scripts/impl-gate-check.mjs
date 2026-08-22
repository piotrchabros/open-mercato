#!/usr/bin/env node
/**
 * impl-gate-check — quality bar evaluator for the implementation pipeline's critic loops.
 *
 *   node .ai/scripts/impl-gate-check.mjs <critic> --module <path> [--state <path>]
 *                                       [--max-rounds N] [--advisory]
 *
 * Critics: architecture · security · code-review · tests · all
 *
 * Exit codes, same contract as spec-gate-check:
 *   0  bar met      → advance
 *   1  bar not met  → onFail.retry sends the implementer back
 *   2  HALT         → writes a HALT marker; stop looping and escalate
 *
 * TWO KINDS OF EVIDENCE, DELIBERATELY.
 *
 *   (a) MECHANICAL checks this script runs itself — greps and file probes over the module.
 *       A critic can be argued with; a grep cannot. These encode the repo's "Never" rules.
 *   (b) COUNTED critic findings from state.json, by severity.
 *
 * A bar needs BOTH clean. Critic sign-off alone is not sufficient, because "an agent said it
 * looked fine" is exactly the subjective bar that lets a loop terminate without improving
 * anything — the same failure the spec pipeline's counted-not-scored rule exists to prevent.
 *
 * DIVERGENCE. If a remediation round leaves more unresolved findings than the round before,
 * the loop is making the code worse and exits 2. Iterating harder on a diverging build
 * produces the code equivalent of wrong sum -> wrong subtraction -> wrong unit. The
 * comparison is PER CRITIC: a bar evaluating `security` alone counts only security's
 * unresolved findings, so measuring it against a whole-run total compares two different
 * things and never fires. `all` is the one place the totals are commensurable.
 *
 * ROUND BUDGETS ARE PER CRITIC, AND THIS SCRIPT OWNS THEM. The four bars used to share
 * one agent-maintained `round` while each carried its own `--max-rounds 3`, so three
 * remediation rounds anywhere spent the budget for all four and the next bar to fail
 * halted with zero retries. Counters now live in a script-owned `gate-rounds.json`
 * beside the state, keyed by critic, incremented here and cleared when a bar passes.
 *
 * ADVISORY MODE (`--advisory`, or OM_GATE_SOFT=1; OM_GATE_STRICT=1 forces strict back).
 * A spent budget still stops the LOOP but no longer aborts the RUN: the halt is recorded
 * and the script exits 0 so the workflow reaches its remaining steps, with the final
 * `all` pass reporting every recorded halt instead of silently succeeding.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const modulePath = flag('module', null)
const statePath = flag('state', '.ai/analysis/impl-pipeline/state.json')
const maxRounds = Number(flag('max-rounds', 3))
// A value that follows a flag is that flag's argument, never the critic name.
const VALUE_OF = new Set([modulePath, statePath, flag('max-rounds', null)].filter(Boolean))
const critic = argv.find((a) => !a.startsWith('--') && !VALUE_OF.has(a)) ?? 'all'

const ANALYSIS_DIR = dirname(statePath)
const haltMarker = (name) => join(ANALYSIS_DIR, `HALT-${name}`)
const LEGACY_HALT = join(ANALYSIS_DIR, 'HALT')
const ROUNDS_FILE = join(ANALYSIS_DIR, 'gate-rounds.json')

const advisory = (argv.includes('--advisory') || process.env.OM_GATE_SOFT === '1')
  && process.env.OM_GATE_STRICT !== '1'

/** Script-owned round counters, one per critic. Absent file → every bar at round 1. */
function readRounds() {
  try { return JSON.parse(readFileSync(ROUNDS_FILE, 'utf8')) } catch { return {} }
}
function writeRounds(rounds) {
  mkdirSync(ANALYSIS_DIR, { recursive: true })
  writeFileSync(ROUNDS_FILE, `${JSON.stringify(rounds, null, 2)}\n`)
}

if (!modulePath) {
  console.error('impl-gate-check: --module <path-to-module-dir> is required')
  process.exit(1)
}

// ── file walking ───────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'migrations' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (['.ts', '.tsx'].includes(extname(p))) out.push(p)
  }
  return out
}
const ALL = walk(modulePath)
const read = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const isTest = (f) => /__tests__|__integration__|\.test\.|\.spec\./.test(f)
const SRC = ALL.filter((f) => !isTest(f))
// A route file is one that EXPORTS an HTTP method handler. Matching on `api/**` alone
// flags helpers like api/openapi.ts and api/helpers.ts, which have no metadata to export.
const HTTP_EXPORT = /export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/
const ROUTES = SRC.filter((f) => /\/api\//.test(f) && HTTP_EXPORT.test(read(f)))
const UI = SRC.filter((f) => extname(f) === '.tsx')

/**
 * A mechanical rule: name, the files it applies to, and a predicate that returns the
 * offending lines. Every rule below encodes a stated repo rule, not a preference.
 */
const rule = (name, files, test, why) => ({ name, why, hits: [...new Set(files)].flatMap((f) => {
  const lines = read(f).split('\n')
  return lines.map((l, i) => (test(l, f) ? `${relative('.', f)}:${i + 1}  ${l.trim().slice(0, 90)}` : null)).filter(Boolean)
}) })

/** A rule that reports once per FILE rather than once per matching line. */
const fileRule = (name, files, test, why) => ({
  name, why,
  hits: [...new Set(files)].filter((f) => test(read(f), f)).map((f) => relative('.', f)),
})

const MECHANICAL = {
  architecture: () => [
    rule('peer entity import', SRC,
      (l) => /import[^;]*\b(ExternalConversation|ExternalMessage|ChannelThreadMapping|MessageChannelLink|MessageReaction)\b/.test(l)
             || /from ['"][^'"]*modules\/(messages|communication_channels)\/data\/entities/.test(l),
      'peer-module entity classes must not cross the boundary — use the source-owned read facade'),
    rule('raw SQL on a peer table', SRC,
      (l) => /(execute|raw|knex|createQueryBuilder)\s*\(/.test(l) && /(external_conversations|external_messages|channel_thread_mappings|\bmessages\b)/.test(l),
      'raw SQL against a peer module is the coupling the read facade exists to retire'),
    rule('peer entity resolved from DI to query it', SRC,
      (l) => /resolve\(\s*['"](ExternalConversation|ExternalMessage|ChannelThreadMapping)['"]/.test(l),
      'entity-class registrations are an EntityManager convenience, not a read API'),
    rule('cross-module ORM relation', SRC,
      (l) => /@ManyToOne\(|@OneToMany\(/.test(l) && !/=>\s*(Connect|connect_)/i.test(l) && /=>\s*[A-Z]/.test(l) && /(CustomerEntity|User|Order|Message|ExternalConversation)/.test(l),
      'no direct ORM relationships between modules — FK-id columns only'),
    rule('direct cache/db client construction', SRC,
      (l) => /new\s+(Redis|IORedis|Database)\s*\(/.test(l),
      'cache resolves through DI; no module constructs a client directly'),
  ],

  security: () => [
    rule('top-level requireAuth export', ROUTES,
      (l) => /^export\s+const\s+requireAuth\b/.test(l),
      'route files export PER-METHOD metadata; a top-level export is a violation'),
    fileRule('route file without a metadata export', ROUTES,
      (src) => !/\bmetadata\b/.test(src),
      'every route file must export per-method metadata (requireAuth / requireFeatures)'),
    rule('requireRoles used', SRC,
      (l) => /requireRoles\b/.test(l),
      'role names are mutable and spoofable — gate on immutable feature ids'),
    rule('raw fetch', SRC,
      (l) => /(^|[^.\w])fetch\s*\(/.test(l) && !/apiCall|readJsonSafe|globalThis\.fetch\s*=/.test(l),
      'HTTP goes through apiCall / apiCallOrThrow / readApiResultOrThrow'),
    rule('secret or token in a log line', SRC,
      (l) => /(logger|console)\.(log|info|warn|error)\([^)]*\b(password|token|secret|credential|apiKey)\b/i.test(l),
      'never log credentials'),
  ],

  'code-review': () => [
    rule('console.* instead of the logger facade', SRC,
      (l) => /(^|[^.\w])console\.(log|info|warn|error|debug)\s*\(/.test(l),
      'use createLogger; console.* is not the structured-logging facade'),
    rule('any type', SRC,
      (l) => /:\s*any\b|<any>|as\s+any\b/.test(l),
      'no `any` — derive types from zod via z.infer, narrow with runtime checks'),
    rule('hardcoded status colour', UI,
      (l) => /\b(text|bg|border|ring)-(red|green|amber|yellow|orange|emerald|rose)-\d{2,3}\b/.test(l),
      'use {property}-status-{status}-{role} tokens'),
    rule('arbitrary Tailwind value', UI,
      (l) => /\b(text|p|px|py|m|mx|my|w|h|gap|rounded|z)-\[[^\]]+\]/.test(l),
      'use the DS scale; arbitrary values are a stated Never'),
    rule('dark: override on a semantic token', UI,
      (l) => /dark:(text|bg|border)-(status|foreground|background|muted|primary|secondary|accent)/.test(l),
      'semantic and status tokens already handle dark mode'),
    rule('window.confirm', UI,
      (l) => /window\.confirm\s*\(/.test(l),
      'use ConfirmDialog / useConfirmDialog'),
  ],

  tests: () => [
    rule('skipped or todo test', ALL.filter(isTest),
      (l) => /\b(it|test|describe)\.(skip|todo)\s*\(/.test(l),
      'a skipped test is an unmet bar wearing a green tick'),
    rule('assertion-free test body', ALL.filter(isTest),
      (l) => /^\s*(it|test)\(.*\)\s*=>\s*\{\s*\}\s*\)/.test(l),
      'an empty test passes and proves nothing'),
  ],
}

const CRITICS = {
  architecture: { title: 'Architecture critic', sev: ['critical', 'high'] },
  security: { title: 'Security critic', sev: ['critical', 'high'] },
  'code-review': { title: 'Code-review critic', sev: ['critical', 'major'] },
  tests: { title: 'Tests critic', sev: ['critical', 'major'] },
}

function loadState() {
  if (!existsSync(statePath)) {
    console.error(`impl-gate-check: no state at ${statePath}`)
    console.error('\nEach critic writes its findings here. Expected shape:')
    console.error(JSON.stringify({
      slice: '<slice id>',
      critics: Object.fromEntries(Object.keys(CRITICS).map((k) => [k, { ran: false, findings: { critical: 0, high: 0, major: 0, minor: 0 }, unresolved: 0 }])),
      validationGate: { ran: false, passed: false, command: null },
      previous: {
        critics: Object.fromEntries(Object.keys(CRITICS).map((k) => [k, { unresolved: null }])),
        totalUnresolved: null,
      },
    }, null, 2))
    process.exit(1)
  }
  try { return JSON.parse(readFileSync(statePath, 'utf8')) }
  catch (e) { console.error(`impl-gate-check: ${statePath} is not valid JSON — ${e.message}`); process.exit(1) }
}

/** Record the halt. Stopping the LOOP is never optional; aborting the RUN is. */
function recordHalt(name, reason, round) {
  mkdirSync(ANALYSIS_DIR, { recursive: true })
  writeFileSync(haltMarker(name), `${new Date().toISOString()}\n${name}\nround ${round}\n${reason}\n`)
}

function halt(name, reason, round) {
  recordHalt(name, reason, round)
  console.error(advisory
    ? `\n  ██  HALT (advisory) — stop looping on this bar; the run continues.\n  ${reason}\n`
    : `\n  ██  HALT — stop looping and escalate to a human.\n  ${reason}\n`)
  console.error('  Iterating harder on a diverging build makes it worse. Report what is failing,')
  console.error('  what you have tried, and which decision you need — then stop.\n')
  if (advisory) {
    console.error('  Advisory mode: this bar is recorded as UNMET and the workflow advances to its')
    console.error('  remaining steps. The definition-of-done pass lists every recorded halt.')
    console.error('  Set OM_GATE_STRICT=1 to make a spent budget abort the run again.\n')
  }
  process.exit(advisory ? 0 : 2)
}

const state = loadState()

const names = critic === 'all' ? Object.keys(CRITICS) : [critic]
if (names.some((n) => !CRITICS[n])) {
  console.error(`impl-gate-check: unknown critic "${critic}" — expected ${Object.keys(CRITICS).join(' · ')} · all`)
  process.exit(1)
}

const rounds = readRounds()
const round = critic === 'all' ? 1 : Number(rounds[critic]) || 1

// A halt already recorded for THIS bar is not re-litigated: strict mode stops until a
// human clears it, advisory mode reports it and lets the workflow move on.
if (critic !== 'all' && (existsSync(haltMarker(critic)) || (!advisory && existsSync(LEGACY_HALT)))) {
  const marker = existsSync(haltMarker(critic)) ? haltMarker(critic) : LEGACY_HALT
  if (!advisory) {
    console.error(`impl-gate-check: HALT marker present (${marker}). Resolve with a human and delete it before resuming.`)
    process.exit(2)
  }
  console.error(`impl-gate-check: ${critic} already halted (${marker}) — advisory mode, advancing without re-running the loop.`)
  process.exit(0)
}

console.log(critic === 'all'
  ? `\nimpl-gate-check — definition of done  ·  ${modulePath}`
  : `\nimpl-gate-check — ${critic} round ${round}/${maxRounds}  ·  ${modulePath}`)
console.log(`${SRC.length} source file(s), ${ALL.length - SRC.length} test file(s)\n`)

let failed = false
let totalUnresolved = 0
const divergedCritics = []

for (const name of names) {
  const def = CRITICS[name]
  const c = state.critics?.[name]
  const owed = []

  // (a) mechanical
  let mechHits = 0
  for (const r of MECHANICAL[name]()) {
    if (r.hits.length === 0) continue
    mechHits += r.hits.length
    owed.push(`${r.hits.length}× ${r.name} — ${r.why}`)
    for (const h of r.hits.slice(0, 4)) owed.push(`      ${h}`)
    if (r.hits.length > 4) owed.push(`      … ${r.hits.length - 4} more`)
  }

  // (b) critic findings
  let diverged = null
  if (!c?.ran) owed.push('critic has not run')
  else {
    const blocking = def.sev.reduce((n, s) => n + Number(c.findings?.[s] ?? 0), 0)
    const unresolved = Number(c.unresolved ?? blocking)
    totalUnresolved += unresolved
    if (unresolved > 0) owed.push(`${unresolved} unresolved ${def.sev.join('/')} finding(s)`)
    // Per critic, so the two numbers measure the same thing. `all` compares the totals
    // below, which is the one place a whole-run figure is commensurable.
    const was = Number(state.previous?.critics?.[name]?.unresolved)
    if (Number.isFinite(was) && unresolved > was) {
      diverged = `unresolved ${name} findings rose ${was} → ${unresolved} — remediation is introducing defects faster than it closes them`
    }
  }

  const ok = owed.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${def.title}${mechHits ? `  (${mechHits} mechanical)` : ''}`)
  for (const o of owed) console.log(`        · ${o}`)
  if (diverged) console.log(`        · DIVERGING — ${diverged}`)
  if (!ok) failed = true
  if (diverged) {
    if (critic !== 'all') halt(name, diverged, round)
    recordHalt(name, diverged, Number(rounds[name]) || 1)
    divergedCritics.push(name)
  }
}

// the validation gate is the one bar no critic can waive
if (critic === 'all' || critic === 'code-review') {
  const v = state.validationGate
  const ok = v?.ran && v?.passed
  console.log(`${ok ? 'PASS' : 'FAIL'}  Validation gate`)
  if (!v?.ran) console.log('        · not run — it is the repo\'s own CI mirror, and it is not optional')
  else if (!v.passed) console.log(`        · failing: ${v.command ?? '(command not recorded)'}`)
  if (!ok) failed = true
}

console.log('')

if (critic === 'all') {
  const prev = Number(state.previous?.totalUnresolved)
  if (Number.isFinite(prev) && totalUnresolved > prev) {
    console.log(`  ██  DIVERGING — unresolved findings rose ${prev} → ${totalUnresolved} across all four critics.`)
    console.log('')
    failed = true
  }
  const halted = [...new Set([...names.filter((n) => existsSync(haltMarker(n))), ...divergedCritics])]
  if (halted.length) {
    console.log('  ██  UNMET BARS — these halted rather than reaching their threshold:')
    for (const n of halted) console.log(`        · ${n}  (see ${haltMarker(n)})`)
    console.log('')
  }
  if (!failed && !halted.length) { console.log('Quality bar met. Advancing.'); process.exit(0) }
  if (advisory) {
    console.log('Advisory mode: the definition of done is NOT met — the findings above are owed.')
    console.log('The run is allowed to complete so its remaining steps report. OM_GATE_STRICT=1 to fail instead.')
    process.exit(0)
  }
  process.exit(halted.length ? 2 : 1)
}

if (!failed) {
  // A bar that passes gives its budget back: a later step can legitimately re-open it,
  // and cezar's own onFail.max is the hard backstop against an endless alternation.
  if (rounds[critic] != null) { delete rounds[critic]; writeRounds(rounds) }
  console.log('Quality bar met. Advancing.')
  process.exit(0)
}
if (round >= maxRounds) halt(critic, `round budget spent (${round}/${maxRounds}) with the bar still unmet`, round)

writeRounds({ ...rounds, [critic]: round + 1 })
console.log(`Bar not met. Fix and re-run — round ${round + 1} of ${maxRounds}.`)
console.log(`Before re-running: set previous.critics.${critic}.unresolved = ${totalUnresolved} so the`)
console.log(`divergence detector can compare like with like. The round counter is kept for you in`)
console.log(`${ROUNDS_FILE} — do not maintain it by hand.`)
process.exit(1)
