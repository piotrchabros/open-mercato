#!/usr/bin/env node
/**
 * impl-gate-check — quality bar evaluator for the implementation pipeline's critic loops.
 *
 *   node .ai/scripts/impl-gate-check.mjs <critic> --module <path> [--state <path>] [--max-rounds N]
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
 * produces the code equivalent of wrong sum -> wrong subtraction -> wrong unit.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'

const argv = process.argv.slice(2)
const critic = argv.find((a) => !a.startsWith('--')) ?? 'all'
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const modulePath = flag('module', null)
const statePath = flag('state', '.ai/analysis/impl-pipeline/state.json')
const maxRounds = Number(flag('max-rounds', 3))
const HALT_MARKER = join(dirname(statePath), 'HALT')

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
      slice: '<slice id>', round: 1,
      critics: Object.fromEntries(Object.keys(CRITICS).map((k) => [k, { ran: false, findings: { critical: 0, high: 0, major: 0, minor: 0 }, unresolved: 0 }])),
      validationGate: { ran: false, passed: false, command: null },
      previous: { totalUnresolved: null },
    }, null, 2))
    process.exit(1)
  }
  try { return JSON.parse(readFileSync(statePath, 'utf8')) }
  catch (e) { console.error(`impl-gate-check: ${statePath} is not valid JSON — ${e.message}`); process.exit(1) }
}

function halt(reason, round) {
  mkdirSync(dirname(HALT_MARKER), { recursive: true })
  writeFileSync(HALT_MARKER, `${new Date().toISOString()}\nround ${round}\n${reason}\n`)
  console.error(`\n  ██  HALT — stop looping and escalate to a human.\n  ${reason}\n`)
  console.error('  Iterating harder on a diverging build makes it worse. Report what is failing,')
  console.error('  what you have tried, and which decision you need — then stop.\n')
  process.exit(2)
}

const state = loadState()
const round = Number(state.round) || 1
if (existsSync(HALT_MARKER)) {
  console.error(`impl-gate-check: HALT marker present (${HALT_MARKER}). Resolve with a human and delete it before resuming.`)
  process.exit(2)
}

const names = critic === 'all' ? Object.keys(CRITICS) : [critic]
if (names.some((n) => !CRITICS[n])) {
  console.error(`impl-gate-check: unknown critic "${critic}" — expected ${Object.keys(CRITICS).join(' · ')} · all`)
  process.exit(1)
}

console.log(`\nimpl-gate-check — round ${round}/${maxRounds}  ·  ${modulePath}`)
console.log(`${SRC.length} source file(s), ${ALL.length - SRC.length} test file(s)\n`)

let failed = false
let totalUnresolved = 0

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
  if (!c?.ran) owed.push('critic has not run')
  else {
    const blocking = def.sev.reduce((n, s) => n + Number(c.findings?.[s] ?? 0), 0)
    const unresolved = Number(c.unresolved ?? blocking)
    totalUnresolved += unresolved
    if (unresolved > 0) owed.push(`${unresolved} unresolved ${def.sev.join('/')} finding(s)`)
  }

  const ok = owed.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${def.title}${mechHits ? `  (${mechHits} mechanical)` : ''}`)
  for (const o of owed) console.log(`        · ${o}`)
  if (!ok) failed = true
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

const prev = state.previous?.totalUnresolved
if (prev != null && totalUnresolved > prev) {
  halt(`unresolved findings rose ${prev} → ${totalUnresolved} — remediation is introducing defects faster than it closes them`, round)
}

if (!failed) { console.log('Quality bar met. Advancing.'); process.exit(0) }
if (round >= maxRounds) halt(`round budget spent (${round}/${maxRounds}) with the bar still unmet`, round)

console.log(`Bar not met. Fix and re-run — round ${round + 1} of ${maxRounds}.`)
console.log(`Before re-running: set previous.totalUnresolved = ${totalUnresolved} and increment round.`)
process.exit(1)
