# Telephony Adapter Contract

**Owner**: `packages/contact-center/src/modules/telephony/lib/adapter.ts`
**Implemented by**: `packages/telephony-<vendor>/src/modules/telephony_<vendor>/`
**Satisfies**: FR-092 to FR-100, SC-020 to SC-022

Deliberately mirrors the shape and lifecycle of the existing `ChannelAdapter` (`packages/core/src/modules/communication_channels/lib/adapter.ts`) so reviewers already know the pattern and the `integrations` registry, credentials and health services apply unchanged (research [R-06](../research.md)).

## Design rules

1. **Vendor-neutral.** No vendor name, header, error code or payload shape appears in this interface. Swapping vendors changes only the provider package (FR-100, SC-022).
2. **Mercato Connect owns policy; the adapter owns transport.** The adapter never decides routing, retry, suppression or recording policy — it receives decisions and reports outcomes.
3. **No media.** Recordings and transcripts cross this boundary as references, never bytes (FR-092).
4. **Idempotent inbound.** Every normalised event carries a stable identity so replayed webhooks are safely deduplicated.
5. **Explicit degradation.** Every method may fail; failure is reported as typed outcome, never a silent empty result (FR-099).

## Interface

```ts
export interface TelephonyCapabilities {
  inboundCalls: boolean
  outboundCalls: boolean
  queueing: boolean
  recording: boolean
  transcription: boolean          // provider supplies transcripts natively
  programmableRouting: boolean    // accepts context supplied at call time (FR-094)
  agentStateSync: boolean         // bidirectional agent state (FR-097)
  callbackScheduling: boolean     // FR-061
  predictiveDialing: boolean      // FR-049
  flowPublish: boolean            // FR-098
  supportedFlowStepTypes: string[]
  maxConcurrentCalls?: number
}

export interface TelephonyAdapter {
  readonly providerKey: string
  readonly capabilities: TelephonyCapabilities

  // Credentials — same lifecycle as ChannelAdapter
  validateCredentials(input: ValidateCredentialsInput): Promise<ValidateCredentialsResult>
  refreshCredentials?(input: RefreshCredentialsInput): Promise<RefreshedCredentials>

  // Inbound
  verifyWebhook(input: VerifyWebhookInput): Promise<boolean>
  normalizeCallEvent(raw: InboundCallPayload): Promise<NormalizedCallEvent>

  // Routing context — called before the provider distributes the call (FR-094)
  supplyRoutingContext(input: RoutingContextInput): Promise<RoutingContextResult>

  // Flow configuration (FR-098)
  validateFlow(input: FlowDefinitionInput): Promise<FlowValidationResult>
  publishFlow(input: FlowDefinitionInput): Promise<FlowPublishResult>
  getPublishedFlowVersion(input: TenantScopedInput): Promise<{ version: number | null }>

  // Live state (FR-096) — results carry their own age; callers must not assume freshness
  getQueueState(input: TenantScopedInput): Promise<QueueStateResult>
  getAgentState(input: AgentStateInput): Promise<AgentStateResult>
  setAgentState(input: SetAgentStateInput): Promise<AgentStateResult>

  // Outbound
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>
  scheduleCallback(input: ScheduleCallbackInput): Promise<ScheduleCallbackResult>

  // Media references only (FR-092)
  getRecordingRef(input: CallScopedInput): Promise<{ ref: string | null; expiresAt?: Date }>
  getTranscriptRef?(input: CallScopedInput): Promise<{ ref: string | null; expiresAt?: Date }>

  // Recording policy is ours; enforcement is theirs (FR-083, FR-093)
  applyRecordingPolicy(input: RecordingPolicyInput): Promise<{ applied: boolean; reason?: string }>
}
```

## Key payload shapes

```ts
export interface NormalizedCallEvent {
  externalCallId: string
  eventType: 'started' | 'answered' | 'queued' | 'transferred' | 'ended'
            | 'recording_available' | 'transcript_available'
  direction: 'inbound' | 'outbound'
  fromIdentifier: string          // encrypted at rest by the telephony module
  toIdentifier: string
  occurredAt: Date                // provider clock — events are ordered by this
  queueRef?: string
  agentRef?: string
  disposition?: 'answered' | 'abandoned' | 'busy' | 'failed' | 'voicemail'
  durationSeconds?: number
  recordingRef?: string
  transcriptRef?: string
  notificationPlayed?: boolean    // FR-083, auditable per contact
  raw: Record<string, unknown>
}

export interface RoutingContextInput {
  externalCallId: string
  callerIdentifier: string
  scope: TenantScope
}

export interface RoutingContextResult {
  targetQueueRef?: string
  priority?: number
  attributes?: Record<string, string | number | boolean>  // customer value, SLA state, open cases
  fallbackToMenu: boolean                                  // set when intent confidence < threshold (FR-059)
}

export interface QueueStateResult {
  queues: Array<{
    queueRef: string
    waitingCount: number
    inHandlingCount: number
    longestWaitSeconds: number
    staffedAgentCount: number
  }>
  capturedAt: Date          // callers render age and honour SC-008
  degraded: boolean         // true when the provider returned partial or stale data
}
```

## Behavioural requirements on implementers

| # | Requirement | Traces to |
|---|---|---|
| T-01 | `verifyWebhook` MUST fail closed. An unverifiable payload produces no side effect and no persisted row. | FR-092 |
| T-02 | `normalizeCallEvent` MUST be pure and idempotent — same input, same output, no writes. | FR-095 |
| T-03 | Out-of-order events MUST be tolerated; ordering is by `occurredAt`, not arrival. | Edge case: unclean termination |
| T-04 | A missing `ended` event MUST NOT strand a call. Implementers expose enough state for the module's reconciliation sweep to close it. | Edge case: unclean termination |
| T-05 | `getQueueState` / `getAgentState` MUST set `capturedAt` honestly and `degraded: true` rather than fabricate current-looking data. | FR-096, SC-021 |
| T-06 | `setAgentState` MUST return the provider's resulting state, so the module reconciles rather than assumes. | FR-097 |
| T-07 | `supplyRoutingContext` MUST be callable before distribution and MUST tolerate an unrecognised caller (no customer match). | FR-094, unrecognised-caller edge case |
| T-08 | `publishFlow` MUST be atomic — partial publication is a failure, not a partial success. | FR-098 |
| T-09 | Recording/transcript refs MUST be retrievable without transferring media through Mercato Connect. | FR-092, FR-085 |
| T-10 | Credential expiry MUST surface as a typed failure the `integrations` health service can render with a renewal action. | FR-099, FR-077 |
| T-11 | No customer content may be sent to any endpoint the operator has not explicitly connected. | FR-085 |

## Registration

Provider packages register through the existing `integrations` registry, exactly as channel providers do:

```ts
// packages/telephony-<vendor>/src/modules/telephony_<vendor>/di.ts
export function register(container: AwilixContainer) {
  container.register({
    [`telephonyAdapter.${providerKey}`]: asValue(adapter),
  })
}
```

Credentials resolve through the `integrations` credentials service (`credentials_ref`), never stored on `TelephonyProviderConnection`. Health reporting reuses `integrations/lib/health-service.ts`, so an expiring credential reaches the operator through the same surface as every other integration (FR-077, SC-010).
