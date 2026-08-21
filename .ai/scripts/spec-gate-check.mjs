#!/usr/bin/env node
/**
 * spec-gate-check — threshold evaluator for the spec pipeline's self-improving loops.
 *
 *   node .ai/scripts/spec-gate-check.mjs <gate> [--state <path>] [--max-rounds N]
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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_STATE = '.ai/analysis/spec-pipeline/gate-state.json'
const DEFAULT_MAX_ROUNDS = 3

const argv = process.argv.slice(2)
const gate = argv.find((a) => !a.startsWith('--')) ?? 'all'
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const statePath = flag('state', DEFAULT_STATE)
const maxRounds = Number(flag('max-rounds', DEFAULT_MAX_ROUNDS))
// The halt marker lives beside the state it refers to, so an overridden --state
// cannot leave a stale marker in the default location (or vice versa).
const HALT_MARKER = join(dirname(statePath), 'HALT')

const num = (v) => (Number.isFinite(v) ? v : 0)

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
        round: 1,
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

function halt(reason, round) {
  mkdirSync(dirname(HALT_MARKER), { recursive: true })
  writeFileSync(HALT_MARKER, `${new Date().toISOString()}\nround ${round}\n${reason}\n`)
  console.error('')
  console.error('  ██  HALT — stop looping and escalate to a human.')
  console.error(`  ${reason}`)
  console.error('')
  console.error('  Another revision is the wrong move here. Three rounds on one document produced')
  console.error('  wrong sum → wrong subtraction → wrong unit: each round fixed the last defect and')
  console.error('  introduced a subtler one. Report what is unresolved, name what would settle it,')
  console.error('  and ask. Some questions cannot be closed by specifying.')
  console.error('')
  process.exit(2)
}

const state = loadState()
const round = num(state.round) || 1
const prev = state.previous?.gates ?? null
const names = gate === 'all' ? Object.keys(GATES) : [gate]

if (names.some((n) => !GATES[n])) {
  console.error(`spec-gate-check: unknown gate "${gate}" — expected one of ${Object.keys(GATES).join(' · ')} · all`)
  process.exit(1)
}

if (existsSync(HALT_MARKER)) {
  console.error(`spec-gate-check: HALT marker present (${HALT_MARKER}). Resolve with a human and delete it before resuming.`)
  process.exit(2)
}

let failed = false
const lines = []

for (const name of names) {
  const def = GATES[name]
  const g = state.gates?.[KEY[name]]
  const { ok, owed } = def.check(g)

  const diverged = def.diverging?.(g, prev?.[KEY[name]])
  if (diverged) halt(`${def.title}: ${diverged}`, round)

  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${def.title}`)
  for (const o of owed) lines.push(`        · ${o}`)
  if (!ok) failed = true
}

console.log('')
console.log(`spec-gate-check — round ${round}/${maxRounds}${state.spec ? `  ·  ${state.spec}` : ''}`)
console.log('')
for (const l of lines) console.log(l)
console.log('')

if (!failed) {
  console.log('Threshold met. Advancing.')
  process.exit(0)
}

if (round >= maxRounds) {
  halt(`round budget spent (${round}/${maxRounds}) with the threshold still unmet`, round)
}

console.log(`Threshold not met. Remediate and re-run — round ${round + 1} of ${maxRounds}.`)
console.log('Before revising: copy this round\'s `gates` block to `previous.gates` and increment `round`,')
console.log('so the divergence detector can see whether the loop is converging.')
process.exit(1)
