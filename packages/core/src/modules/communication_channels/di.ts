import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  CommunicationChannel,
  ExternalConversation,
  ExternalMessage,
  MessageChannelLink,
  ChannelThreadMapping,
  MessageReaction,
  SharedChannelMembership,
  SharedInboxOAuthState,
} from './data/entities'
import { getChannelAdapterRegistry } from './lib/adapter-registry-singleton'
import { ensureTestSeedAdapterRegistered } from './lib/test-seed'
import { sendAsUser } from './lib/send-as-user'
import { checkSharedInboxAuthorization } from './lib/shared-inbox-authorization'

export function register(container: AppContainer) {
  // Test-only: register the network-free stub channel adapter when
  // `OM_ENABLE_TEST_CHANNEL_SEEDING` is set (no-op in production). Lets the
  // integration harness connect a channel + complete the outbound send chain.
  // See lib/test-seed.ts.
  ensureTestSeedAdapterRegistered()

  container.register({
    // Entity class registrations (for EntityManager lookups by string)
    CommunicationChannel: asValue(CommunicationChannel),
    ExternalConversation: asValue(ExternalConversation),
    ExternalMessage: asValue(ExternalMessage),
    MessageChannelLink: asValue(MessageChannelLink),
    ChannelThreadMapping: asValue(ChannelThreadMapping),
    MessageReaction: asValue(MessageReaction),
    SharedChannelMembership: asValue(SharedChannelMembership),
    SharedInboxOAuthState: asValue(SharedInboxOAuthState),

    // Channel adapter registry — process-wide singleton backed by globalThis so
    // the auth-less webhook route resolves the same registry as DI consumers.
    // See lib/adapter-registry-singleton.ts.
    channelAdapterRegistry: asValue(getChannelAdapterRegistry()),

    // In-process send-as-user facade. Cross-module callers (e.g. the customers
    // compose route) resolve this instead of making an HTTP self-call.
    communicationChannelsSendAsUser: asValue(sendAsUser),

    // Source-owned shared-inbox authorization (Connect upstream Contract E).
    // The single canonical answer to "may this actor use this shared channel in
    // this organization?" — consumed by the send, thread-reader and inbound
    // envelope contracts so the rule has exactly one implementation.
    // See lib/shared-inbox-authorization.ts.
    communicationChannelsSharedInboxAuthorization: asValue(checkSharedInboxAuthorization),
  })
}
