import type { EntityManager } from '@mikro-orm/postgresql'
import { asFunction, asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  ConnectCase,
  ConnectCaseTransition,
  ConnectContactIdentity,
  ConnectConversation,
  ConnectConversationCaseBinding,
  ConnectDomainOutboxEntry,
  ConnectIdentityCaseBinding,
  ConnectInboundReceipt,
  ConnectInboundSuppression,
  ConnectSettings,
  ConnectAssignmentAudit,
  ConnectCaseReadState,
  ConnectOutbox,
  ConnectOutboundAttempt,
  ConnectOutboundMessage,
  ConnectUnknownDelivery,
  ConnectIdentityLinkAudit,
  ConnectManualMatchTask,
  ConnectPendingProjection,
  ConnectPendingRetraction,
  ConnectRetractionSaga,
  ConnectOperationalFact,
  ConnectMetricDaily,
  ConnectPrincipalClassification,
  ConnectPrincipalClassificationChange,
  ConnectPrincipalClassificationManifestEntry,
  ConnectCaseGenerationFact,
  ConnectCaseWaitFact,
  ConnectOutboundDeliveryFact,
  ConnectCaseNumberSequence,
  ConnectCaseReparenting,
  ConnectCaseReparentingItem,
} from './data/entities'
import { createCapabilityReporter } from './lib/activation'
import { createConnectCaseReparentingReader } from './lib/case-reparenting-reader'
import { createConnectContactDenominatorReader } from './lib/contact-denominator-reader'
import { createConnectCurrentCaseCountReader } from './lib/current-case-count-reader'
import { createConnectOperationalMetricsReader } from './lib/operational-metrics-reader'
import { createDefaultConnectPrincipalKindReader } from './lib/principal-classification'
import { createConnectCaseSlaReader } from './lib/sla-source-reader'
import { createConnectPrincipalClassificationProvisioningService } from './lib/principal-classification-provisioning'
import { createConnectPrincipalClassificationManifestService } from './lib/principal-classification-manifest'

export function register(container: AppContainer) {
  container.register({
    // Entity class registrations (for EntityManager lookups by string).
    ConnectCase: asValue(ConnectCase),
    ConnectCaseTransition: asValue(ConnectCaseTransition),
    ConnectContactIdentity: asValue(ConnectContactIdentity),
    ConnectConversation: asValue(ConnectConversation),
    ConnectConversationCaseBinding: asValue(ConnectConversationCaseBinding),
    ConnectDomainOutboxEntry: asValue(ConnectDomainOutboxEntry),
    ConnectIdentityCaseBinding: asValue(ConnectIdentityCaseBinding),
    ConnectInboundReceipt: asValue(ConnectInboundReceipt),
    ConnectInboundSuppression: asValue(ConnectInboundSuppression),
    ConnectSettings: asValue(ConnectSettings),
    ConnectAssignmentAudit: asValue(ConnectAssignmentAudit),
    ConnectCaseReadState: asValue(ConnectCaseReadState),
    ConnectOutbox: asValue(ConnectOutbox),
    ConnectOutboundAttempt: asValue(ConnectOutboundAttempt),
    ConnectOutboundMessage: asValue(ConnectOutboundMessage),
    ConnectUnknownDelivery: asValue(ConnectUnknownDelivery),
    ConnectIdentityLinkAudit: asValue(ConnectIdentityLinkAudit),
    ConnectManualMatchTask: asValue(ConnectManualMatchTask),
    ConnectPendingProjection: asValue(ConnectPendingProjection),
    ConnectPendingRetraction: asValue(ConnectPendingRetraction),
    ConnectRetractionSaga: asValue(ConnectRetractionSaga),
    ConnectOperationalFact: asValue(ConnectOperationalFact),
    ConnectMetricDaily: asValue(ConnectMetricDaily),
    ConnectPrincipalClassification: asValue(ConnectPrincipalClassification),
    ConnectPrincipalClassificationChange: asValue(ConnectPrincipalClassificationChange),
    ConnectPrincipalClassificationManifestEntry: asValue(ConnectPrincipalClassificationManifestEntry),
    ConnectCaseGenerationFact: asValue(ConnectCaseGenerationFact),
    ConnectCaseWaitFact: asValue(ConnectCaseWaitFact),
    ConnectOutboundDeliveryFact: asValue(ConnectOutboundDeliveryFact),
    ConnectCaseNumberSequence: asValue(ConnectCaseNumberSequence),
    ConnectCaseReparenting: asValue(ConnectCaseReparenting),
    ConnectCaseReparentingItem: asValue(ConnectCaseReparentingItem),
    // The container runs in Awilix CLASSIC injection mode, which resolves each
    // dependency by parameter name. A destructured `({ em })` parameter has no
    // resolvable name and silently arrives as undefined: the reader then returns
    // no classifications and the manifest service throws on `em.find`.
    connectPrincipalKindReader: asFunction((em: EntityManager) =>
      createDefaultConnectPrincipalKindReader(em, container),
    ).scoped(),
    // Additive, STABLE contract read by `connect_routing` to build its capacity
    // projection. Connect answers "which Cases are current work" so no consumer
    // has to re-derive that rule against `connect_cases` directly.
    connectCurrentCaseCountReader: asFunction((em: EntityManager) =>
      createConnectCurrentCaseCountReader(em),
    ).scoped(),
    connectPrincipalClassificationProvisioningService: asFunction(() =>
      createConnectPrincipalClassificationProvisioningService(container),
    ).scoped(),
    connectPrincipalClassificationManifestService: asFunction((
      em: EntityManager,
      connectPrincipalClassificationProvisioningService: ReturnType<
        typeof createConnectPrincipalClassificationProvisioningService
      >,
    ) => createConnectPrincipalClassificationManifestService({
      em,
      provisioningService: connectPrincipalClassificationProvisioningService,
    })).scoped(),

    // The ONLY supported read path into Connect's SLA source facts. Same named
    // parameter rule as above: CLASSIC injection resolves `em` by name, and a
    // destructured parameter would leave the reader querying through undefined
    // and returning empty pages that look exactly like "no data".
    connectCaseSlaReader: asFunction((em: EntityManager) =>
      createConnectCaseSlaReader(em, container),
    ).scoped(),

    // Outward-facing read contracts optional consumers resolve through
    // `tryResolve`. Named `em` parameters preserve CLASSIC injection.
    connectCaseReparentingReader: asFunction((em: EntityManager) =>
      createConnectCaseReparentingReader(em),
    ).scoped(),
    connectContactDenominatorReader: asFunction((em: EntityManager) =>
      createConnectContactDenominatorReader(em),
    ).scoped(),
    // `connect_analytics` composes reports through this facade without touching
    // Connect entities, keeping the storage and counter semantics owned here.
    connectOperationalMetricsReader: asFunction((em: EntityManager) =>
      createConnectOperationalMetricsReader(em),
    ).scoped(),

    // Read by `communication_channels` Contract E before it lets an
    // administrator cut a shared channel over to Connect projection. Connect
    // reports what is actually resolvable, not what this build intends to
    // support — a Connect-managed channel with no recovery schedules would
    // strand receipts after any outage. See lib/activation.ts.
    connectCapabilityReporter: asValue(createCapabilityReporter(container)),
  })
}
