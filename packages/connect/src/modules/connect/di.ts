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
  ConnectCaseNumberSequence,
  ConnectCaseReparenting,
  ConnectCaseReparentingItem,
} from './data/entities'
import { createCapabilityReporter } from './lib/activation'
import { createConnectCaseReparentingReader } from './lib/case-reparenting-reader'
import { createConnectContactDenominatorReader } from './lib/contact-denominator-reader'
import { createDefaultConnectPrincipalKindReader } from './lib/principal-classification'
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

    /**
     * The two outward-facing read contracts optional consumers resolve through
     * `tryResolve`. Named `em` parameters, not a destructured object: CLASSIC
     * injection resolves by parameter NAME, so `({ em })` would silently hand
     * the factory `undefined` and the reader would answer "no rows" for every
     * scope — a failure that reads exactly like an empty database.
     */
    connectCaseReparentingReader: asFunction((em: EntityManager) =>
      createConnectCaseReparentingReader(em),
    ).scoped(),
    connectContactDenominatorReader: asFunction((em: EntityManager) =>
      createConnectContactDenominatorReader(em),
    ).scoped(),

    // Read by `communication_channels` Contract E before it lets an
    // administrator cut a shared channel over to Connect projection. Connect
    // reports what is actually resolvable, not what this build intends to
    // support — a Connect-managed channel with no recovery schedules would
    // strand receipts after any outage. See lib/activation.ts.
    connectCapabilityReporter: asValue(createCapabilityReporter(container)),
  })
}
