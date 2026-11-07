import { z } from 'zod'

export const sesCredentialsSchema = z.object({
  region: z.string().min(1),
  fromAddress: z.string().email(),
  replyToAddress: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().email('Reply-To address must be a valid email').optional()),
  configurationSetName: z.string().min(1).optional(),
})

export type SesCredentials = z.infer<typeof sesCredentialsSchema>
