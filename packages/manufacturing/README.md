# @open-mercato/manufacturing

Manufacturing planning module for SMB discrete manufacturing (MTO/MTS): versioned BOMs and routings, work centers, manufacturing orders with technology snapshots, a minimal manufacturing stock ledger, net MRP, and shop-floor reporting.

Spec: [`.ai/specs/2026-07-18-manufacturing-planning-module.md`](../../.ai/specs/2026-07-18-manufacturing-planning-module.md)

## Enabling

1. The module is wired in `apps/mercato/src/modules.ts` as `{ id: 'manufacturing', from: '@open-mercato/manufacturing' }`.
2. The entire surface is gated by the `manufacturing_enabled` feature toggle and is **disabled by default** (fail-closed). Enable it per tenant from **Backend → Feature Toggles** (create the boolean toggle `manufacturing_enabled` and set it to `true`, or add a per-tenant override).
3. Sync role grants for existing tenants: `yarn mercato auth sync-role-acls`.

## Roles

`setup.ts` seeds feature grants for: `admin` (all), `employee` (read-only), and the module-specific roles `technolog`, `planista`, `kierownik`, `magazynier-lite`, and `operator` (shop-floor surface only).
