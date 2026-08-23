export const metadata = {
  id: 'connect_routing',
  title: 'Mercato Connect Routing',
  description:
    'Capacity foundation for Connect routing: routing-owned agent-presence storage plus the idempotent backfill that initializes each agent\'s current case count from existing Case ownership. Routing itself — service queues, offers, capacity enforcement and live presence — is not part of this module yet, and every presence row it writes stays `offline`.',
}

export default metadata
