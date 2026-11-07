import { z } from 'zod'

export const resendCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  fromAddress: z.string().email(),
  replyToAddress: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().email('Reply-To address must be a valid email').optional()),
})

export type ResendCredentials = z.infer<typeof resendCredentialsSchema>
