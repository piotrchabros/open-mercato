# Peer Read Facade Contract

**Owners**: `packages/core/src/modules/communication_channels/`, `packages/core/src/modules/messages/`
**Consumer**: `packages/contact-center/src/modules/conversations/`
**Closes**: ANALYSIS-051 **C1** | **Tasks**: T019–T022

## Why this exists

`conversations` needs to read thread bindings and thread messages that other modules own. `.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"* records the rule:

> Put peer-module table access behind a DI service owned by the source module. Optional consumers should resolve a narrow local interface fail-soft, distinguish missing and ambiguous data, and include disabled-module coverage. **Treat an existing cross-module raw SQL query as coupling to retire, not a pattern to repeat.**

Two things make this non-optional here:

1. **The existing entity registrations are not a read API.** `communication_channels/di.ts` registers `ExternalConversation`, `ExternalMessage`, `ChannelThreadMapping` and friends under a comment that says exactly what they are for: *"Entity class registrations (for EntityManager lookups by string)"*. Resolving them from another module and writing your own queries is still storage coupling — it just launders the import.
2. **`messages` has no DI surface at all.** No `di.ts` exists. Without one, the only ways to read thread messages are importing the `Message` entity across a package boundary or writing raw SQL — both violations.

The sanctioned precedent lives in the same file as the anti-pattern: `communicationChannelsSendAsUser`, described as *"In-process send-as-user facade. Cross-module callers (e.g. the customers compose route) resolve this instead of making an HTTP self-call."* These facades follow that shape.

## Backward compatibility

Both are **new DI registration keys** — BC surface #9, ADDITIVE-ONLY. No existing key is renamed, no existing behaviour changes, no deprecation bridge required. Once shipped they become STABLE and fall under the deprecation protocol.

## `communicationChannelsThreadReader`

Registered by `communication_channels/di.ts`; implemented in `lib/thread-reader.ts`.

```ts
export interface ChannelThreadBinding {
  externalConversationId: string
  channelId: string
  channelType: string
  providerKey: string
  externalThreadRef: string | null
  lastMessageAt: Date | null
}

export interface CommunicationChannelsThreadReader {
  getThreadBindings(input: {
    threadId: string
    tenantId: string
    organizationId: string
  }): Promise<ChannelThreadBinding[]>

  getBindingsForCustomer(input: {
    customerId: string
    tenantId: string
    organizationId: string
  }): Promise<ChannelThreadBinding[]>
}
```

## `messagesThreadReader`

Registered by a **new** `messages/di.ts`; implemented in `lib/thread-reader.ts`.

```ts
export interface ThreadMessage {
  id: string
  threadId: string
  direction: 'inbound' | 'outbound' | 'system' | 'bot'
  authorLabel: string | null
  channelType: string | null
  body: string
  bodyFormat: 'text' | 'markdown' | 'html'
  deliveryStatus: string | null
  attachments: Array<{ id: string; fileName: string; mimeType: string }>
  occurredAt: Date
}

export interface MessagesThreadReader {
  getThreadMessages(input: {
    threadId: string
    tenantId: string
    organizationId: string
    limit?: number          // default 100, hard cap 200
    before?: Date           // cursor for long threads
  }): Promise<{ messages: ThreadMessage[]; hasMore: boolean }>
}
```

## Requirements on both implementations

| # | Requirement | Why |
|---|---|---|
| P-01 | `tenantId` and `organizationId` are **required** parameters, and every query filters on both. A caller cannot opt out. | FR-082, SC-016 — tenancy cannot depend on the consumer remembering |
| P-02 | **Batched.** Resolving N bindings issues a bounded number of queries, never one per binding. | SC-003's 2-second budget; ANALYSIS-051 medium risk "thread assembly N+1" |
| P-03 | Return **plain typed projections**, never ORM entity instances. | Prevents the consumer re-acquiring a live reference to the peer's schema, which would recreate the coupling |
| P-04 | Distinguish **empty** from **missing**: an existing thread with no messages returns `[]`; an unknown thread id is distinguishable from it. | The lesson requires consumers to "distinguish missing and ambiguous data" |
| P-05 | **No decrypted PII beyond what the caller needs.** Message bodies come back per the peer's own encryption handling; identifiers do not travel in these projections. | FR-085; keeps the search-index exclusion in T043 honest |
| P-06 | Pure reads — no writes, no events, no side effects. | Keeps the facade safe to call from a subscriber |
| P-07 | Consumer resolves via `tryResolve` and degrades with a named explanation when absent. | FR-091; verified by `module-decoupling.test.ts` (T078) |
| P-08 | Documented in the owning module's `AGENTS.md` under "Public Contract Surfaces", matching the `staff` module precedent. | Makes the new BC surface discoverable (T022) |
| P-09 | The **consumer** logs via `createLogger` when `tryResolve` yields nothing, so a degraded thread is distinguishable from a genuinely empty one in operations. | ANALYSIS-052 D5 — silent degradation reads as "no messages" |

## Consumer rules

In `conversations`, the following are violations, not shortcuts:

- `em.find('ExternalConversation', …)` or any string-keyed EM lookup against a peer entity
- importing `Message`, `ExternalConversation`, `ChannelThreadMapping` or any peer entity class
- raw SQL touching `messages`, `external_conversations`, `external_messages` or `channel_thread_mappings`
- resolving the peer's entity-class DI keys in order to query them

T024 (thread aggregation) and T041 (inbound binding) are the two places this rule binds. Both consume the facades through `tryResolve`.
