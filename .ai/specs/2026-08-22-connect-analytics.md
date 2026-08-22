# Mercato Connect — Analytics and Cost Inputs

## TLDR

**Key points:**

- Add organization-scoped reporting over Phase 1 operational metric facts without copying message content or other PII into analytics storage.
- Add manual and provider-invoice cost inputs for agent, channel, and AI cost attribution and cost-per-contact reporting.
- Backfill `current_case_count` idempotently before Phase 3 routing can consume capacity state.

**Scope:**

- Reporting for response time, resolution time, delivery, suppression, and reconciliation facts.
- `connect_cost_input` CRUD and cost-per-contact aggregation.
- Enable-time `current_case_count` backfill with tenant and organization isolation.

**Concerns:**

- Implementation is gated on Phase 1 manual QA completion in issue #12.
- Analytics must remain useful when `connect_sla` is disabled and must never expose raw message content or identity PII.

## Open Questions

- **Q1**: Should SLA-derived reports be an optional analytics integration in this spec, allowing analytics to deploy independently, or should analytics explicitly depend on `connect_sla`?

## Overview

This successor spec will define the Phase 2 analytics capability against the Phase 1 as-built facts and APIs. It will keep reporting organization-scoped, aggregate-first, and PII-free while exposing auditable cost inputs and preparing accurate capacity counts for the later routing phase.

## Problem Statement

Phase 1 emits operational facts but does not provide reporting or cost attribution. Operators cannot compare service outcomes or calculate cost per contact, and Phase 3 routing would over-push agents if it starts from an empty `current_case_count` instead of current Case ownership.

## Proposed Solution

Introduce an independently deployable analytics module that queries or aggregates sanctioned Phase 1 facts, stores scoped cost inputs with provenance, and performs an idempotent capacity-count backfill. The full architecture, contracts, risks, tests, and implementation plan will be completed after Q1 settles whether SLA reporting is a soft-optional seam or a hard module dependency.

