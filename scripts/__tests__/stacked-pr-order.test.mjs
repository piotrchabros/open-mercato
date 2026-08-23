import test from 'node:test'
import assert from 'node:assert/strict'

import { planStackedOrderStatuses, summarizeStackedOrderStatuses } from '../lib/stacked-pr-order.mjs'

function statusFor(statuses, number) {
  const match = statuses.find((status) => status.number === number)
  assert.ok(match, `expected a status for #${number}`)
  return match
}

test('blocks a pull request whose head branch is another open pull request base', () => {
  // The 2026-08-23 collapse: #26 merged seven seconds before #27, carrying
  // cez/4434f80e into mercato-connect before the code landed on it.
  const statuses = planStackedOrderStatuses([
    { number: 26, head: 'cez/4434f80e', base: 'mercato-connect', sha: 'a1' },
    { number: 27, head: 'cez/4434f80e-principal-kind', base: 'cez/4434f80e', sha: 'b2' },
    { number: 29, head: 'cez/4434f80e-principal-provisioning', base: 'cez/4434f80e-principal-kind', sha: 'c3' },
  ])

  assert.equal(statusFor(statuses, 26).state, 'failure')
  assert.deepEqual(statusFor(statuses, 26).blockedBy, [27])
  assert.equal(statusFor(statuses, 27).state, 'failure')
  assert.deepEqual(statusFor(statuses, 27).blockedBy, [29])
  assert.equal(statusFor(statuses, 29).state, 'success')
  assert.deepEqual(statusFor(statuses, 29).blockedBy, [])
})

test('clears the parent once the dependent pull request is no longer open', () => {
  const statuses = planStackedOrderStatuses([
    { number: 26, head: 'cez/4434f80e', base: 'mercato-connect', sha: 'a1' },
  ])

  assert.equal(statusFor(statuses, 26).state, 'success')
  assert.equal(statusFor(statuses, 26).description, 'No open pull request targets this branch')
})

test('reports every dependent when a branch fans out', () => {
  const statuses = planStackedOrderStatuses([
    { number: 1, head: 'trunk', base: 'crm', sha: 'a1' },
    { number: 2, head: 'leaf-a', base: 'trunk', sha: 'b2' },
    { number: 3, head: 'leaf-b', base: 'trunk', sha: 'c3' },
  ])

  assert.deepEqual(statusFor(statuses, 1).blockedBy, [2, 3])
  assert.match(statusFor(statuses, 1).description, /merge #2, #3 first/)
})

test('independent pull requests never block each other', () => {
  const statuses = planStackedOrderStatuses([
    { number: 10, head: 'fix/one', base: 'crm', sha: 'a1' },
    { number: 11, head: 'fix/two', base: 'crm', sha: 'b2' },
  ])

  assert.ok(statuses.every((status) => status.state === 'success'))
})

test('a pull request targeting its own head branch does not block itself', () => {
  const statuses = planStackedOrderStatuses([
    { number: 12, head: 'loop', base: 'loop', sha: 'a1' },
  ])

  assert.equal(statusFor(statuses, 12).state, 'success')
})

test('keeps the status description within the GitHub limit', () => {
  const dependents = Array.from({ length: 40 }, (_, index) => ({
    number: index + 2,
    head: `leaf-${index}`,
    base: 'trunk',
    sha: `s${index}`,
  }))
  const statuses = planStackedOrderStatuses([
    { number: 1, head: 'trunk', base: 'crm', sha: 'a1' },
    ...dependents,
  ])

  assert.ok(statusFor(statuses, 1).description.length <= 140)
})

test('summary names each blocked pull request and its blockers', () => {
  const summary = summarizeStackedOrderStatuses(planStackedOrderStatuses([
    { number: 26, head: 'cez/4434f80e', base: 'mercato-connect', sha: 'a1' },
    { number: 27, head: 'cez/4434f80e-principal-kind', base: 'cez/4434f80e', sha: 'b2' },
  ]))

  assert.match(summary, /1 of 2 open pull requests must wait:/)
  assert.match(summary, /- #26 is blocked by #27/)
})

test('summary is clean when nothing is stacked', () => {
  const summary = summarizeStackedOrderStatuses(planStackedOrderStatuses([
    { number: 10, head: 'fix/one', base: 'crm', sha: 'a1' },
  ]))

  assert.match(summary, /safe to merge in any order/)
})
