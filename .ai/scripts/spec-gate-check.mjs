#!/usr/bin/env node
/**
 * spec-gate-check — threshold evaluator for the spec pipeline's self-improving loops.
 *
 *   node .ai/scripts/spec-gate-check.mjs <gate> [--state <path>] [--max-rounds N] [--advisory]
 *
 * Gates: claims · core-edit · write-path · review · frozen · all
 *
 * Exit codes are the loop control surface:
 *   0  threshold met            → the workflow advances
 *   1  threshold not met        → onFail.retry sends the agent back to remediate
 *   2  HALT                     → writes a HALT marker; the loop must stop and escalate
 *                                 to a human instead of revising again
 *
 * WHY EXIT 2 EXISTS. This pipeline was derived from an engagement where three review
 * rounds each fixed the previous defect and introduced a subtler one a level down
 * (wrong sum → wrong subtraction → wrong unit). More iterations made the document
 * worse, not better, and every round felt like progress from the inside. A loop with
 * no divergence detector reproduces that. So: when a round introduces more unverified
 * claims than it resolves, or the round budget is spent with the threshold still unmet,
 * this exits 2 and the pipeline asks a human rather than producing a fourth variant.
 *
 * The agent writes .ai/analysis/spec-pipeline/gate-state.json each round. Counts must
 * be COUNTED from the ledger artifacts, never asserted from memory — miscounted
 * headline figures that propagated across documents are one of the defects this
 * pipeline exists to catch.
 *
 * ROUND BUDGETS ARE PER GATE, AND THIS SCRIPT OWNS THEM. Every gate used to read one
 * shared `round` field off the agent's state while carrying its own `--max-rounds`, so
 * the counter was global and monotonic while the budgets were local: `review` alone
 * needs three rounds to reach its two dry rounds, which left `frozen --max-rounds 2`
 * halting on first contact with zero retries. The counters now live in a script-owned
 * `gate-rounds.json` beside the state, keyed by gate, incremented here on each failing
 * evaluation and cleared when the gate passes. The agent no longer keeps them — it only
 * maintains `previous.gates`, which is about content, not counting.
 *
 * ADVISORY MODE (`--advisory`, or OM_GATE_SOFT=1; OM_GATE_STRICT=1 forces strict back).
 * A spent budget still stops the LOOP — that is the whole point of the divergence
 * detector — but it no longer aborts the RUN. The halt is recorded as a marker and the
 * script exits 0 so the workflow reaches its remaining steps, and the final `all` pass
 * reports every recorded halt in a banner instead of silently succeeding.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_STATE = '.ai/analysis/spec-pipeline/gate-state.json'
const DEFAULT_MAX_ROUNDS = 3

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const statePath = flag('state', DEFAULT_STATE)
// A value that follows a flag is that flag's argument, never the gate name.
const VALUE_OF = new Set([statePath, flag('max-rounds', null)].filter(Boolean))
const gate = argv.find((a) => !a.startsWith('--') && !VALUE_OF.has(a)) ?? 'all'
const maxRounds = Number(flag('max-rounds', DEFAULT_MAX_ROUNDS))
// Markers and counters live beside the state they refer to, so an overridden
// --state cannot leave a stale one in the default location (or vice versa).
const ANALYSIS_DIR = dirname(statePath)
// Per gate: a halt in `claims` must not pre-fail `frozen`, and must never
// pre-fail the definition-of-done pass that reports on all of them.
const haltMarker = (name) => join(ANALYSIS_DIR, `HALT-${name}`)
const LEGACY_HALT = join(ANALYSIS_DIR, 'HALT')
const ROUNDS_FILE = join(ANALYSIS_DIR, 'gate-rounds.json')

const advisory = (argv.includes('--advisory') || process.env.OM_GATE_SOFT === '1')
  && process.env.OM_GATE_STRICT !== '1'

const num = (v) => (Number.isFinite(v) ? v : 0)

/** Script-owned round counters, one per gate. Absent file → every gate at round 1. */
function readRounds() {
  try { return JSON.parse(readFileSync(ROUNDS_FILE, 'utf8')) } catch { return {} }
}
function writeRounds(rounds) {
  mkdirSync(ANALYSIS_DIR, { recursive: true })
  writeFileSync(ROUNDS_FILE, `${JSON.stringify(rounds, null, 2)}\n`)
}

/**
 * Each gate answers: is the threshold met, and what is still owed?
 * Thresholds are countable facts, never subjective scores — "zero uncitable rows
 * carrying a decision" is checkable; "quality >= 8/10" is not, and a loop cannot
 * converge on a number the judge re-invents each round.
 */
const GATES = {
  claims: {
    title: 'Gate 1 — claims ledger',
    check(g) {
      const owed = []
      if (g == null) return { ok: false, owed: ['gate-state.json has no `gates.claims` block'] }
      if (num(g.rows) === 0) owed.push('ledger is empty — no claims extracted')
      if (num(g.loadBearingUnresolved) > 0)
        owed.push(`${g.loadBearingUnresolved} OVERSTATED/REFUTED/UNCITABLE row(s) still carry a decision`)
      if (num(g.unstruckFalseClaims) > 0)
        owed.push(`${g.unstruckFalseClaims} known-false claim(s) still present in the spec text`)
      if (g.ungated === true)
        owed.push('ledger is UNGATED — author and verifier are the same agent; a different agent must re-run it')
      return { ok: owed.length === 0, owed }
    },
    diverging(g, prev) {
      if (!g || !prev) return null
      const introduced = num(g.newClaimsIntroduced)
      const resolved = num(g.rowsResolved)
      if (introduced > resolved)
        return `round introduced ${introduced} new unverified claim(s) while resolving ${resolved} — the loop is diverging`
      return null
    },
  },

  'core-edit': {
    title: 'Gate 2 — out-of-scope-edit ledger',
    check(g) {
      const owed = []
      if (g == null) return { ok: false, owed: ['gate-state.json has no `gates.coreEdit` block'] }
      if (g.ruleQuoted !== true)
        owed.push("this repo's rule on editing shared/core code is not quoted (quote it, or state that none exists)")
      const risky = num(g.classDorE)
      if (num(g.justified) < risky)
        owed.push(`${risky - num(g.justified)} entity/signature change(s) without a stated reason the sanctioned extension route was rejected`)
      if (num(g.assignedUpstreamPr) < risky)
        owed.push(`${risky - num(g.assignedUpstreamPr)} entity/signature change(s) not assigned to a separate upstream PR`)
      return { ok: owed.length === 0, owed }
    },
  },

  'write-path': {
    title: 'Write-path test',
    check(g) {
      const owed = []
      if (g == null) return { ok: false, owed: ['gate-state.json has no `gates.writePath` block'] }
      const total = num(g.headlineRequirements)
      if (total === 0) owed.push('no headline requirements recorded')
      const gap = total - num(g.withWriteTask)
      if (gap > 0)
        owed.push(`${gap} headline requirement(s) have no task that performs their write — they have no mechanism`)
      if (num(g.staleTaskRefs) > 0)
        owed.push(`${g.staleTaskRefs} task cross-reference(s) point at a task that has become something else`)
      return { ok: owed.length === 0, owed }
    },
  },

  review: {
    title: 'Review — loop until dry',
    check(g) {
      const owed = []
      if (g == null) return { ok: false, owed: ['gate-state.json has no `gates.review` block'] }
      if (num(g.rolesRun) < 4)
        owed.push(`only ${num(g.rolesRun)}/4 reviewer roles ran (DDD · Architect · PM-UX · Implementer)`)
      if (num(g.unresolvedCritical) > 0)
        owed.push(`${g.unresolvedCritical} unresolved critical finding(s)`)
      if (num(g.dryRounds) < 2)
        owed.push(`only ${num(g.dryRounds)}/2 consecutive rounds with no new findings — discovery is not exhausted`)
      return { ok: owed.length === 0, owed }
    },
    diverging(g, prev) {
      if (!g || !prev) return null
      if (num(g.newFindings) > num(prev.newFindings) && num(prev.newFindings) > 0)
        return `finding count rose (${prev.newFindings} → ${g.newFindings}) — remediation is introducing defects faster than it closes them`
      return null
    },
  },

  frozen: {
    title: 'Gate 3 — frozen surfaces',
    check(g) {
      const owed = []
      if (g == null) return { ok: false, owed: ['gate-state.json has no `gates.frozenSurfaces` block'] }
      const gap = num(g.surfacesTotal) - num(g.surfacesCovered)
      if (num(g.surfacesTotal) === 0) owed.push("this repo's contract surfaces are not enumerated")
      if (gap > 0) owed.push(`${gap} contract surface(s) not covered`)
      if (num(g.conflictsWithOtherDocs) > 0)
        owed.push(`${g.conflictsWithOtherDocs} identifier(s) disagree with another document — reconcile before the first migration`)
      if (num(g.wildcardedIds) > 0)
        owed.push(`${g.wildcardedIds} identifier group(s) hidden behind a wildcard — enumerate them`)
      return { ok: owed.length === 0, owed }
    },
  },
}

const KEY = { claims: 'claims', 'core-edit': 'coreEdit', 'write-path': 'writePath', review: 'review', frozen: 'frozenSurfaces' }

function loadState() {
  if (!existsSync(statePath)) {
    console.error(`spec-gate-check: no state at ${statePath}`)
    console.error('')
    console.error('The gate cannot pass on an artifact that does not exist. Write it this round:')
    console.error(JSON.stringify(
      {
        spec: '<path to the spec under test>',
        gates: {
          claims: { rows: 0, confirmed: 0, overstated: 0, refuted: 0, uncitable: 0, loadBearingUnresolved: 0, unstruckFalseClaims: 0, ungated: true, newClaimsIntroduced: 0, rowsResolved: 0 },
          coreEdit: { rows: 0, classDorE: 0, justified: 0, assignedUpstreamPr: 0, ruleQuoted: false },
          writePath: { headlineRequirements: 0, withWriteTask: 0, staleTaskRefs: 0 },
          review: { rolesRun: 0, newFindings: 0, dryRounds: 0, unresolvedCritical: 0 },
          frozenSurfaces: { surfacesTotal: 0, surfacesCovered: 0, conflictsWithOtherDocs: 0, wildcardedIds: 0 },
        },
      }, null, 2))
    console.error('')
    console.error('Every count is COUNTED from the ledger artifacts, never asserted from memory.')
    process.exit(1)
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (err) {
    console.error(`spec-gate-check: ${statePath} is not valid JSON — ${err.message}`)
    process.exit(1)
  }
}

/** Record the halt. Stopping the LOOP is never optional; aborting the RUN is. */
function recordHalt(name, reason, round) {
  mkdirSync(ANALYSIS_DIR, { recursive: true })
  writeFileSync(haltMarker(name), `${new Date().toISOString()}\n${name}\nround ${round}\n${reason}\n`)
}

function haltBanner(reason) {
  console.error('')
  console.error(advisory
    ? '  ██  HALT (advisory) — stop looping on this gate; the run continues.'
    : '  ██  HALT — stop looping and escalate to a human.')
  console.error(`  ${reason}`)
  console.error('')
  console.error('  Another revision is the wrong move here. Three rounds on one document produced')
  console.error('  wrong sum → wrong subtraction → wrong unit: each round fixed the last defect and')
  console.error('  introduced a subtler one. Report what is unresolved, name what would settle it,')
  console.error('  and ask. Some questions cannot be closed by specifying.')
  if (advisory) {
    console.error('')
    console.error('  Advisory mode: this gate is now recorded as UNMET and the workflow advances to')
    console.error('  its remaining steps. The definition-of-done pass lists every recorded halt.')
    console.error('  Set OM_GATE_STRICT=1 to make a spent budget abort the run again.')
  }
  console.error('')
}

/** A single-gate halt ends this invocation: exit 2 (strict) or 0 (advisory, run continues). */
function halt(name, reason, round) {
  recordHalt(name, reason, round)
  haltBanner(reason)
  process.exit(advisory ? 0 : 2)
}

const state = loadState()
const prev = state.previous?.gates ?? null
const names = gate === 'all' ? Object.keys(GATES) : [gate]

if (names.some((n) => !GATES[n])) {
  console.error(`spec-gate-check: unknown gate "${gate}" — expected one of ${Object.keys(GATES).join(' · ')} · all`)
  process.exit(1)
}

const rounds = readRounds()
const round = gate === 'all' ? 1 : num(rounds[gate]) || 1

// A halt already recorded for THIS gate is not re-litigated: strict mode stops until a
// human clears it, advisory mode reports it and lets the workflow move on.
if (gate !== 'all' && (existsSync(haltMarker(gate)) || (!advisory && existsSync(LEGACY_HALT)))) {
  const marker = existsSync(haltMarker(gate)) ? haltMarker(gate) : LEGACY_HALT
  if (!advisory) {
    console.error(`spec-gate-check: HALT marker present (${marker}). Resolve with a human and delete it before resuming.`)
    process.exit(2)
  }
  console.error(`spec-gate-check: ${gate} already halted (${marker}) — advisory mode, advancing without re-running the loop.`)
  process.exit(0)
}

let failed = false
const lines = []
const divergedGates = []

for (const name of names) {
  const def = GATES[name]
  const g = state.gates?.[KEY[name]]
  const { ok, owed } = def.check(g)

  const diverged = def.diverging?.(g, prev?.[KEY[name]])
  if (diverged) {
    // In `all` mode this is a report, not a control flow: the definition-of-done pass
    // evaluates every gate before it decides anything.
    if (gate !== 'all') halt(name, `${def.title}: ${diverged}`, round)
    recordHalt(name, `${def.title}: ${diverged}`, num(rounds[name]) || 1)
    divergedGates.push(name)
  }

  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${def.title}`)
  for (const o of owed) lines.push(`        · ${o}`)
  if (diverged) lines.push(`        · DIVERGING — ${diverged}`)
  if (!ok) failed = true
}

console.log('')
console.log(gate === 'all'
  ? `spec-gate-check — definition of done${state.spec ? `  ·  ${state.spec}` : ''}`
  : `spec-gate-check — ${gate} round ${round}/${maxRounds}${state.spec ? `  ·  ${state.spec}` : ''}`)
console.log('')
for (const l of lines) console.log(l)
console.log('')

if (gate === 'all') {
  const halted = [...new Set([...names.filter((n) => existsSync(haltMarker(n))), ...divergedGates])]
  if (halted.length) {
    console.log('  ██  UNMET GATES — these halted rather than reaching their threshold:')
    for (const n of halted) console.log(`        · ${n}  (see ${haltMarker(n)})`)
    console.log('')
  }
  if (!failed && !halted.length) {
    console.log('Threshold met. Advancing.')
    process.exit(0)
  }
  if (advisory) {
    console.log('Advisory mode: the definition of done is NOT met — the findings above are owed.')
    console.log('The run is allowed to complete so its remaining steps report. OM_GATE_STRICT=1 to fail instead.')
    process.exit(0)
  }
  process.exit(halted.length ? 2 : 1)
}

if (!failed) {
  // A gate that passes gives its budget back: a later step can legitimately re-open it,
  // and cezar's own onFail.max is the hard backstop against an endless alternation.
  if (rounds[gate] != null) { delete rounds[gate]; writeRounds(rounds) }
  console.log('Threshold met. Advancing.')
  process.exit(0)
}

if (round >= maxRounds) {
  halt(gate, `round budget spent (${round}/${maxRounds}) with the threshold still unmet`, round)
}

writeRounds({ ...rounds, [gate]: round + 1 })
console.log(`Threshold not met. Remediate and re-run — round ${round + 1} of ${maxRounds}.`)
console.log('Before revising: copy this round\'s `gates` block to `previous.gates`, so the')
console.log('divergence detector can see whether the loop is converging. The round counter is')
console.log(`kept for you in ${ROUNDS_FILE} — do not maintain it by hand.`)
process.exit(1)
