import { expect, test } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createOfferFixture,
  FAKE_INCOMPLETE_MARKER,
  listRevisions,
  orgFetch,
  readOffer,
  readOfferHtml,
  readProgressJobStatus,
  setupOfferTestEnv,
  waitForGenerationRun,
  type OfferTestEnv,
} from './support/fixtures'

type GenerationStartBody = { runId?: string; progressJobId?: string; code?: string }

async function startGeneration(env: OfferTestEnv, offerId: string, data: Record<string, unknown>) {
  return orgFetch(env, 'POST', `/api/offer_generator/offers/${offerId}/generate`, { data })
}

async function startGenerationOk(
  env: OfferTestEnv,
  offerId: string,
  data: Record<string, unknown>,
): Promise<{ runId: string; progressJobId: string }> {
  const response = await startGeneration(env, offerId, data)
  const body = await readJsonSafe<GenerationStartBody>(response)
  expect(response.status(), 'POST generate should return 202').toBe(202)
  expect(body?.runId, 'generate response should include runId').toBeTruthy()
  expect(body?.progressJobId, 'generate response should include progressJobId').toBeTruthy()
  return { runId: body?.runId as string, progressJobId: body?.progressJobId as string }
}

test.describe('TC-OFFER-002: AI generation with the fake generator', () => {
  test('generates, refines, fails on incomplete output and rejects a concurrent start', async ({ request }) => {
    test.setTimeout(240_000)
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)
      const offerId = await createOfferFixture(env, { title: 'QA generation offer', language: 'en' })
      const heading = `QA generated offer ${Date.now()}`

      const generate = await startGenerationOk(env, offerId, {
        kind: 'generate',
        prompt: `${heading}\nScope: website redesign, three packages, monthly retainer.`,
      })
      const generated = await waitForGenerationRun(env, generate.runId)
      expect(generated.status).toBe('completed')
      expect(generated.kind).toBe('generate')
      expect(generated.errorCode).toBeNull()
      expect(generated.progressJobId).toBe(generate.progressJobId)
      expect(await readProgressJobStatus(env, generate.progressJobId)).toBe('completed')

      const afterGenerate = await readOfferHtml(env, offerId)
      expect(afterGenerate.html).toContain('data-fake-generate')
      expect(afterGenerate.html).toContain(heading)
      expect(afterGenerate.html).toMatch(/<html[^>]*lang="en"/i)
      const offerAfterGenerate = await readOffer(env, offerId)
      expect(offerAfterGenerate.hasHtml).toBe(true)
      expect(offerAfterGenerate.generationStatus).toBe('idle')
      expect(offerAfterGenerate.lastGenerationRunId).toBe(generate.runId)

      const feedback = 'Add a short paragraph about the warranty period.'
      const refine = await startGenerationOk(env, offerId, { kind: 'refine', feedback })
      const refined = await waitForGenerationRun(env, refine.runId)
      expect(refined.status).toBe('completed')
      expect(refined.kind).toBe('refine')
      expect(refined.resultRevisionId, 'refine should keep the previous HTML as a revision').toBeTruthy()
      expect(await readProgressJobStatus(env, refine.progressJobId)).toBe('completed')

      const afterRefine = await readOfferHtml(env, offerId)
      expect(afterRefine.html).toContain('data-fake-refine')
      expect(afterRefine.html).toContain(feedback)
      expect(afterRefine.html).toContain(heading)
      const revisions = await listRevisions(env, offerId)
      const refineRevision = revisions.find((revision) => revision.id === refined.resultRevisionId)
      expect(refineRevision, 'the refine revision should be listed').toBeTruthy()
      expect(refineRevision?.source).toBe('refine')
      expect(refineRevision?.generationRunId).toBe(refine.runId)
      expect(refineRevision?.feedback).toBe(feedback)

      const incomplete = await startGenerationOk(env, offerId, {
        kind: 'generate',
        prompt: `QA incomplete offer\nThis brief carries ${FAKE_INCOMPLETE_MARKER} to break the output.`,
      })
      const failed = await waitForGenerationRun(env, incomplete.runId)
      expect(failed.status).toBe('failed')
      expect(failed.errorCode).toBe('incomplete_html')
      expect(await readProgressJobStatus(env, incomplete.progressJobId)).toBe('failed')
      const afterFailure = await readOfferHtml(env, offerId)
      expect(afterFailure.html, 'a failed run must leave the HTML unchanged').toBe(afterRefine.html)
      expect((await readOffer(env, offerId)).generationStatus).toBe('failed')
      expect((await listRevisions(env, offerId)).length).toBe(revisions.length)

      const concurrentPayload = { kind: 'refine', feedback: 'Shorten the pricing section a little.' }
      const [first, second] = await Promise.all([
        startGeneration(env, offerId, concurrentPayload),
        startGeneration(env, offerId, concurrentPayload),
      ])
      const statuses = [first.status(), second.status()].sort((left, right) => left - right)
      expect(statuses, 'exactly one concurrent start should win').toEqual([202, 409])
      const loser = first.status() === 409 ? first : second
      const winner = first.status() === 202 ? first : second
      const loserBody = await readJsonSafe<GenerationStartBody>(loser)
      expect(loserBody?.code).toBe('generation_active')
      const winnerBody = await readJsonSafe<GenerationStartBody>(winner)
      expect(winnerBody?.runId).toBeTruthy()
      const concurrentRun = await waitForGenerationRun(env, winnerBody?.runId as string)
      expect(concurrentRun.status).toBe('completed')
    } finally {
      if (env) await env.cleanup()
    }
  })
})
