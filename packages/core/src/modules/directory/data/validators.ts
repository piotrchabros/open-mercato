import { z } from 'zod'
import { isAllowedAppOrigin, normalizeAppOrigin } from '@open-mercato/shared/lib/url'

export const tenantCreateSchema = z.object({
  name: z.string().min(1).max(200),
  isActive: z.boolean().optional(),
})

export const tenantUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
})

const slugField = z.string().trim().toLowerCase().regex(/^[a-z0-9\-_]+$/).max(150).optional().nullable()
const logoUrlField = z
  .union([
    z.string().trim().url().max(2048).refine(
      (value) => value.startsWith('https://') || value.startsWith('http://'),
      { message: 'Logo URL must use http or https.' },
    ),
    z.string().trim().regex(/^\/api\/attachments\/(?:image|file)\/[A-Za-z0-9%_.~/?=&-]+$/).max(2048),
  ])
  .optional()
  .nullable()

export const organizationCreateSchema = z.object({
  tenantId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  slug: slugField,
  logoUrl: logoUrlField,
  logoPreserveAspectRatio: z.boolean().optional(),
  isActive: z.boolean().optional(),
  parentId: z.string().uuid().nullable().optional(),
  childIds: z.array(z.string().uuid()).optional(),
})

export const organizationUpdateSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  slug: slugField,
  logoUrl: logoUrlField,
  logoPreserveAspectRatio: z.boolean().optional(),
  isActive: z.boolean().optional(),
  parentId: z.string().uuid().nullable().optional(),
  childIds: z.array(z.string().uuid()).optional(),
  appUrl: z.string().trim().max(2048).nullable().optional(),
})

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>
export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>
export type OrganizationCreateInput = z.infer<typeof organizationCreateSchema>
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>

export type OrganizationAppUrlCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'invalid' | 'notAllowed' }

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function normalizeOrganizationAppUrl(
  value: string | null,
  env: Record<string, string | undefined> = process.env,
): OrganizationAppUrlCheck {
  if (value === null || value.trim() === '') return { ok: true, value: null }
  const origin = normalizeAppOrigin(value)
  if (!origin) return { ok: false, reason: 'invalid' }
  if (env.NODE_ENV === 'production') {
    const url = new URL(origin)
    if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
      return { ok: false, reason: 'invalid' }
    }
  }
  if (!isAllowedAppOrigin(origin, env)) return { ok: false, reason: 'notAllowed' }
  return { ok: true, value: origin }
}
