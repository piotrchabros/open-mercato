# Mercato Connect — SLA

## TLDR

**Key points:**

- Add organization-scoped SLA policies and generation-aware Case clocks without moving first-response state onto the Phase 1 Case aggregate.
- Stamp `responded_at` once per generation only for a proven human response or a human-accepted AI draft; preserve clock history across split and merge operations.
- Backfill first-response clocks idempotently from Phase 1 inbound/outbound facts when the module is enabled.

**Scope:**

- `connect_sla_policy` and versioned policy evaluation.
- `connect_sla_case_clock`, including response and resolution deadlines, immutable first response, split inheritance, and merged-clock outcomes.
- A timezone-correct business-calendar capability, with its final module boundary pending Q1.

**Concerns:**

- Implementation is gated on Phase 1 manual QA completion in issue #12.
- DST correctness and concurrent response stamping are data-integrity requirements, not presentation details.

## Open Questions

- **Q1**: Should the timezone-correct business calendar be owned by `connect_sla`, or implemented as a reusable upstream correction to `planner`?
- **Q2**: Should the business calendar remain part of this SLA successor spec, or ship as a third independently reviewable successor spec?

## Overview

This successor spec will define the Phase 2 SLA capability against the Phase 1 as-built model in `.ai/specs/2026-08-22-connect-phase-1-v2.md`, not the superseded umbrella design. It will preserve Phase 1 raw facts as the source for idempotent enable-time backfill and keep SLA state independently disableable without deleting data.

## Problem Statement

Phase 1 records inbound and outbound activity but deliberately has no SLA clock or first-response column. Phase 2 needs policy-driven, business-time deadlines and stable response/resolution reporting without misclassifying automated or unresolvable authors as humans, resetting clocks during Case re-parenting, or producing DST-dependent results.

## Proposed Solution

Introduce an additive SLA module with versioned policies, generation-aware clocks, event-driven stamping, an idempotent backfill, and explicit business-time calculation. The full architecture, contracts, risks, tests, and implementation plan will be completed after Q1–Q2 settle the module and spec boundaries.

