/**
 * Connect analytics access control.
 *
 * Three features, split by what the caller can actually see:
 *
 * - `view` is the aggregate operational report. It carries no money and no
 *   agent grain, so a manager can hold it without gaining financial access.
 * - `cost_inputs.view` reads recorded spend. Costs are a different audience
 *   from operational volume: an invoice amount is commercially sensitive in a
 *   way a response percentile is not, which is why `connect_analytics.view`
 *   alone deliberately does not imply it.
 * - `cost_inputs.manage` records and corrects those rows, including provider
 *   invoice provenance. It depends on `.view` because correcting a row you
 *   cannot read is not a coherent act.
 */
export const features = [
  {
    id: 'connect_analytics.view',
    title: 'View Connect operational analytics',
    module: 'connect_analytics',
  },
  {
    id: 'connect_analytics.cost_inputs.view',
    title: 'View Connect cost accounting inputs',
    module: 'connect_analytics',
  },
  {
    id: 'connect_analytics.cost_inputs.manage',
    title: 'Record and correct Connect cost accounting inputs',
    module: 'connect_analytics',
    dependsOn: ['connect_analytics.cost_inputs.view'],
  },
] as const

export default features
