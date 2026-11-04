import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_FIELD_MAPPING } from '../data/entities'
import { graphLeadSchema, leadgenChangeValueSchema, webhookPayloadSchema } from '../data/validators'
import { applyMapping } from '../lib/mapping'
import { computeHubSignature, verifyHubSignature } from '../lib/signature'

const FIXTURES_DIR = join(__dirname, 'fixtures')
const API_DIR = join(__dirname, '..', 'api')
const APP_SECRET = 'contract-test-app-secret'

function readFixtureRaw(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

function readFixture(name: string): unknown {
  return JSON.parse(readFixtureRaw(name))
}

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry)
    if (statSync(fullPath).isDirectory()) return collectRouteFiles(fullPath)
    return entry === 'route.ts' ? [fullPath] : []
  })
}

describe('webhook notification contract', () => {
  it('parses the single-entry notification and its leadgen change value', () => {
    const payload = webhookPayloadSchema.parse(readFixture('webhook-single.json'))
    expect(payload.entry).toHaveLength(1)
    const [change] = payload.entry[0].changes
    expect(change.field).toBe('leadgen')
    const value = leadgenChangeValueSchema.parse(change.value)
    expect(value.leadgen_id).toBe('724501983112233')
    expect(value.page_id).toBe(payload.entry[0].id)
    expect(value.form_id).toBe('551200347890123')
  })

  it('parses the multi-entry notification and yields three leadgen changes', () => {
    const payload = webhookPayloadSchema.parse(readFixture('webhook-multi.json'))
    expect(payload.entry).toHaveLength(2)
    const changes = payload.entry.flatMap((entry) => entry.changes)
    const leadgenChanges = changes.filter((change) => change.field === 'leadgen')
    expect(changes).toHaveLength(4)
    expect(leadgenChanges).toHaveLength(3)
    for (const change of leadgenChanges) {
      expect(leadgenChangeValueSchema.safeParse(change.value).success).toBe(true)
    }
  })

  it('rejects a notification whose object is not page', () => {
    const payload = { ...(readFixture('webhook-single.json') as object), object: 'user' }
    expect(webhookPayloadSchema.safeParse(payload).success).toBe(false)
  })
})

describe('hub signature over the recorded raw body', () => {
  it.each(['webhook-single.json', 'webhook-multi.json'])('round-trips for %s', (name) => {
    const rawBody = readFixtureRaw(name)
    const header = computeHubSignature(rawBody, APP_SECRET)
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifyHubSignature(rawBody, header, APP_SECRET)).toBe(true)
    expect(verifyHubSignature(Buffer.from(rawBody, 'utf8'), header, APP_SECRET)).toBe(true)
  })

  it('fails on a re-serialized body, a wrong secret and a missing header', () => {
    const rawBody = readFixtureRaw('webhook-single.json')
    const header = computeHubSignature(rawBody, APP_SECRET)
    const reserialized = JSON.stringify(JSON.parse(rawBody))
    expect(verifyHubSignature(reserialized, header, APP_SECRET)).toBe(false)
    expect(verifyHubSignature(rawBody, header, 'another-secret')).toBe(false)
    expect(verifyHubSignature(rawBody, null, APP_SECRET)).toBe(false)
  })
})

describe('Graph lead response contract', () => {
  it('parses the recorded lead response', () => {
    const lead = graphLeadSchema.parse(readFixture('graph-lead.json'))
    expect(lead.id).toBe('724501983112233')
    expect(lead.form_id).toBe('551200347890123')
    expect(lead.platform).toBe('ig')
    expect(lead.is_organic).toBe(false)
    expect(lead.field_data).toHaveLength(8)
  })

  it('maps the lead with the default mapping to the expected person fields', () => {
    const lead = graphLeadSchema.parse(readFixture('graph-lead.json'))
    const mapped = applyMapping(lead.field_data, DEFAULT_FIELD_MAPPING, [])
    expect(mapped.person).toEqual({
      primaryEmail: 'jan.nowak@example.com',
      primaryPhoneRaw: '+48600100200',
      fullName: 'Jan Nowak',
      jobTitle: 'Project manager',
      city: 'Warszawa',
    })
    expect(mapped.company).toEqual({ displayName: 'Nowak Development' })
    expect(mapped.notes).toEqual([
      { label: 'budget', value: '500k-1M' },
      { label: 'consent_marketing', value: 'I agree to marketing contact' },
    ])
    expect(mapped.consents).toEqual([])
  })
})

describe('API route files', () => {
  const routeFiles = collectRouteFiles(API_DIR)

  it('discovers the route files', () => {
    expect(routeFiles.length).toBeGreaterThan(0)
  })

  it.each(routeFiles.map((file) => [file.slice(API_DIR.length + 1), file]))(
    '%s exports openApi and metadata',
    (_relative, file) => {
      const source = readFileSync(file, 'utf8')
      expect(source).toMatch(/export\s+const\s+openApi\b/)
      expect(source).toMatch(/export\s+const\s+metadata\b/)
    },
  )
})
