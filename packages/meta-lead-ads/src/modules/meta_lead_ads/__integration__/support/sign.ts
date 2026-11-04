import { computeHubSignature } from '../../lib/signature'

export const TEST_APP_SECRET = 'meta-lead-ads-test-app-secret'

export function signBody(raw: string, secret: string = TEST_APP_SECRET): string {
  return computeHubSignature(raw, secret)
}

export function buildLeadgenNotification(
  entries: { pageId: string; leads: { leadId: string; formId: string }[] }[],
): string {
  const createdTime = Math.floor(Date.now() / 1000)
  return JSON.stringify({
    object: 'page',
    entry: entries.map((entry) => ({
      id: entry.pageId,
      time: createdTime,
      changes: entry.leads.map((lead) => ({
        field: 'leadgen',
        value: {
          leadgen_id: lead.leadId,
          page_id: entry.pageId,
          form_id: lead.formId,
          created_time: createdTime,
        },
      })),
    })),
  })
}
