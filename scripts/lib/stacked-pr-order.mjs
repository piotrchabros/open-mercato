const STATUS_CONTEXT = 'stacked-pr-order'
const DESCRIPTION_LIMIT = 140

function truncate(value) {
  return value.length <= DESCRIPTION_LIMIT ? value : `${value.slice(0, DESCRIPTION_LIMIT - 1)}…`
}

function describeBlockers(blockers) {
  const numbers = blockers.map((pull) => `#${pull.number}`).join(', ')
  const noun = blockers.length === 1 ? 'PR targets' : 'PRs target'
  return truncate(`${blockers.length} open ${noun} this branch — merge ${numbers} first`)
}

/**
 * Maps every open pull request to the commit status the ordering guard should publish.
 *
 * A pull request is blocked when another open pull request uses its head branch as a base:
 * merging it first would strand the dependent work on a branch nothing points at any more.
 */
export function planStackedOrderStatuses(pulls) {
  const dependentsByBase = new Map()
  for (const pull of pulls) {
    const existing = dependentsByBase.get(pull.base) ?? []
    existing.push(pull)
    dependentsByBase.set(pull.base, existing)
  }

  return pulls.map((pull) => {
    const blockers = (dependentsByBase.get(pull.head) ?? [])
      .filter((candidate) => candidate.number !== pull.number)
      .sort((left, right) => left.number - right.number)

    return {
      number: pull.number,
      sha: pull.sha,
      context: STATUS_CONTEXT,
      state: blockers.length > 0 ? 'failure' : 'success',
      description: blockers.length > 0
        ? describeBlockers(blockers)
        : 'No open pull request targets this branch',
      blockedBy: blockers.map((blocker) => blocker.number),
    }
  })
}

export function summarizeStackedOrderStatuses(statuses) {
  const blocked = statuses.filter((status) => status.state === 'failure')
  if (blocked.length === 0) {
    return `All ${statuses.length} open pull requests are safe to merge in any order.`
  }
  const lines = blocked.map((status) => `- #${status.number} is blocked by ${status.blockedBy.map((n) => `#${n}`).join(', ')}`)
  return [`${blocked.length} of ${statuses.length} open pull requests must wait:`, ...lines].join('\n')
}

export { STATUS_CONTEXT }
