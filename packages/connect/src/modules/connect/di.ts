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
} from './data/entities'
import { createCapabilityReporter } from './lib/activation'
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
    connectPrincipalKindReader: asFunction(({ em }: { em: EntityManager }) =>
      createDefaultConnectPrincipalKindReader(em, container),
    ).scoped(),
    connectPrincipalClassificationProvisioningService: asFunction(() =>
      createConnectPrincipalClassificationProvisioningService(container),
    ).scoped(),
    connectPrincipalClassificationManifestService: asFunction(({
      em,
      connectPrincipalClassificationProvisioningService,
    }: {
      em: EntityManager
      connectPrincipalClassificationProvisioningService: ReturnType<
        typeof createConnectPrincipalClassificationProvisioningService
      >
    }) => createConnectPrincipalClassificationManifestService({
      em,
      provisioningService: connectPrincipalClassificationProvisioningService,
    })).scoped(),

    // Read by `communication_channels` Contract E before it lets an
    // administrator cut a shared channel over to Connect projection. Connect
    // reports what is actually resolvable, not what this build intends to
    // support — a Connect-managed channel with no recovery schedules would
    // strand receipts after any outage. See lib/activation.ts.
    connectCapabilityReporter: asValue(createCapabilityReporter(container)),
  })
}
