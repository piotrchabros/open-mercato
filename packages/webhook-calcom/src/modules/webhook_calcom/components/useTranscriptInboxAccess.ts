"use client"

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { hasFeature } from '@open-mercato/shared/security/features'

type FeatureCheckResponse = {
  granted?: string[]
}

const INBOX_FEATURES = [
  'webhook_calcom.transcripts.view',
  'webhook_calcom.transcripts.manage',
  'customers.interactions.manage',
  'customers.people.view',
]

export function useTranscriptInboxAccess() {
  const [granted, setGranted] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const call = await apiCall<FeatureCheckResponse>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: INBOX_FEATURES }),
        })
        if (!cancelled) {
          setGranted(Array.isArray(call.result?.granted) ? call.result.granted : [])
        }
      } catch {
        if (!cancelled) setGranted([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  const canManage = hasFeature(granted, 'webhook_calcom.transcripts.manage')

  return {
    isLoading,
    canManage,
    canAssign:
      canManage &&
      hasFeature(granted, 'customers.interactions.manage') &&
      hasFeature(granted, 'customers.people.view'),
    canViewPeople: hasFeature(granted, 'customers.people.view'),
  }
}
