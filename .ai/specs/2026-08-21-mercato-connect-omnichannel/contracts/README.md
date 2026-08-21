# Contracts Index: Mercato Connect

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md) | **Data model**: [../data-model.md](../data-model.md)

| Contract | Covers |
|---|---|
| [rest-api.md](./rest-api.md) | HTTP surface per module — CRUD routes, custom action routes, mutation-guard mapping, optimistic-lock 409 |
| [peer-read-facades.md](./peer-read-facades.md) | Source-owned DI read facades on `messages` and `communication_channels` (ANALYSIS-051 C1) |
| [telephony-adapter.md](./telephony-adapter.md) | Vendor-neutral `TelephonyAdapter` interface implemented by `packages/telephony-<vendor>/` |
| [events.md](./events.md) | Event IDs, payload shapes, broadcast flags, subscriber persistence |
| [acl.md](./acl.md) | ACL features per module and `defaultRoleFeatures` grants |
| [ui-extension.md](./ui-extension.md) | Widget spot IDs, DataTable ids, CrudForm entity ids, portal pages |

## Conventions that apply to every contract here

**Backward compatibility.** Everything in these files is a **new** contract surface — new API routes, event IDs, DI keys, ACL features, widget spot IDs, entity ids. Per [`BACKWARD_COMPATIBILITY.md`](../../../../BACKWARD_COMPATIBILITY.md) new surfaces are unconstrained on first release and become STABLE or FROZEN afterwards. Exactly one existing surface is touched: `ChannelCapabilities` gains an optional `voice?: boolean` (research [R-09](../research.md)), which is ADDITIVE-ONLY and needs no deprecation protocol.

**Naming.**
- Modules: plural `snake_case`. Event IDs: `module.entity.action` (singular entity, past-tense action).
- ACL features: `<module>.<action>`. API routes: `/api/<module>/<resource>`.
- Widget spots follow the host conventions in `packages/core/AGENTS.md` § Spot IDs.
- Entity ids are consumed as `E.<module>.<entity>` from the generated registry, never written as string literals.

**Auto-discovery.** Every file named in these contracts is discovered by the generator. `yarn generate` MUST run after adding or changing `events.ts`, `acl.ts`, `setup.ts`, `ce.ts`, `translations.ts`, `data/enrichers.ts`, `subscribers/*`, `workers/*`, `widgets/*`, `api/*` or `backend/*`.

**Tenancy.** Every route, event payload and adapter call carries `tenantId` and `organizationId`. Scope is derived from the authenticated context, never from request input. Event subscribers use trusted scope from `emit(..., options)`, never payload-provided scope.

**i18n.** No user-facing string appears in any contract payload. Labels travel as i18n keys (`labelKey`, `descriptionKey`, `name_key`) resolved per locale; the suite ships `pl` and `en`.
