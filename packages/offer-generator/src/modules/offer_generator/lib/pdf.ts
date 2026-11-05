import { existsSync } from 'node:fs'
import { renderPdfWithChromium } from '@open-mercato/documents/modules/documents/lib/pdfRenderer'
import { sanitizeOfferHtml } from './html-sanitize'
import { injectPrintStyles } from './html-utils'

const COMMON_CHROMIUM_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const DEFAULT_PDF_ASSET_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']
const ALLOWED_RESOURCE_TYPES = new Set(['stylesheet', 'font', 'image'])
const DATA_URI_RESOURCE_TYPES = new Set(['image', 'font'])

export type OfferPdfRequestDescriptor = {
  url: string
  resourceType: string
  isNavigationRequest: boolean
}

type PdfEnv = Record<string, string | undefined>

export function resolveOfferPdfChromiumPath(env: PdfEnv = process.env): string | null {
  const configured =
    env.OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH?.trim() ||
    env.DOCUMENTS_PDF_CHROMIUM_PATH?.trim() ||
    env.PUPPETEER_EXECUTABLE_PATH?.trim()
  if (configured) return configured
  return COMMON_CHROMIUM_PATHS.find((path) => existsSync(path)) ?? null
}

export function readPdfAssetHosts(env: PdfEnv = process.env): string[] {
  const raw = env.OM_OFFER_GENERATOR_PDF_ASSET_HOSTS
  if (raw === undefined) return [...DEFAULT_PDF_ASSET_HOSTS]
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
}

export function isAllowedOfferPdfRequest(
  request: OfferPdfRequestDescriptor,
  hosts: readonly string[],
): boolean {
  if (request.isNavigationRequest) return false
  if (!ALLOWED_RESOURCE_TYPES.has(request.resourceType)) return false
  if (/^data:/i.test(request.url)) return DATA_URI_RESOURCE_TYPES.has(request.resourceType)
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return hosts.includes(parsed.hostname.toLowerCase())
}

export function buildOfferPdfFilename({ slug }: { slug: string }): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe || 'offer'}.pdf`
}

export async function renderOfferPdf(html: string, executablePath: string): Promise<Uint8Array> {
  const hosts = readPdfAssetHosts()
  return renderPdfWithChromium({
    html: injectPrintStyles(sanitizeOfferHtml(html)),
    executablePath,
    isAllowedRequest: (request) =>
      isAllowedOfferPdfRequest(
        {
          url: request.url(),
          resourceType: request.resourceType(),
          isNavigationRequest: request.isNavigationRequest(),
        },
        hosts,
      ),
  })
}
