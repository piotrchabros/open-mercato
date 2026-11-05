import { createModuleQueue, type Queue } from '@open-mercato/queue'
import type { GenerateOfferJob } from '../data/validators'
import { QUEUES } from './constants'

let generateQueue: Queue<GenerateOfferJob> | null = null

export function getGenerateQueue(): Queue<GenerateOfferJob> {
  if (!generateQueue) {
    generateQueue = createModuleQueue<GenerateOfferJob>(QUEUES.generate, { attempts: 1, concurrency: 2 })
  }
  return generateQueue
}

export function enqueueGenerateOffer(job: GenerateOfferJob): Promise<string> {
  return getGenerateQueue().enqueue(job)
}
