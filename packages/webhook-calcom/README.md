# @open-mercato/webhook-calcom

Cal.com (cal.diy) inbound webhook integration for Open Mercato. It turns Cal.com bookings into CRM meeting interactions and attaches notetaker transcripts to the person.

## What it does

- Bookings (`BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`) create or update a **meeting interaction** (`customers:customer_interaction`) on the matched person. Created/requested/rescheduled bookings are `planned`; cancelled/rejected bookings are canceled.
- `MEETING_ENDED` marks the meeting interaction **completed**.
- `RECORDING_TRANSCRIPTION_GENERATED` from the cal.diy notetaker adds the transcript as a `.txt` **attachment on the person** (visible in the person's Files tab) that is also **assigned to the meeting interaction**. When the summary is `READY`, it is posted as a **comment on the person** titled `Meeting summary: <meeting title>` (comments cannot reference an interaction; the body is truncated to 8000 characters). The meeting is marked completed if it is not already in a terminal status. Legacy Cal Video/Daily transcript events (no `notetaker` block) are ignored.
- A transcript for a meeting **without an event type** or with an unknown booking either creates the meeting from the transcript or lands in the **Unassigned transcripts** inbox (see below).
- Any other trigger succeeds and is ignored.

Handlers (`webhook-handlers.ts`): `webhook_calcom:booking` (`BOOKING_*`), `webhook_calcom:meeting-ended` (`MEETING_ENDED`) and `webhook_calcom:transcript` (`RECORDING_TRANSCRIPTION_GENERATED`). Each handler runs in the inbound-dispatch queue worker with its own request container; a booking/meeting handler whose organization has no valid Cal.com credentials skips the delivery and writes a `credentials_missing` integration log entry.

Endpoint: `POST /api/webhooks/inbound/calcom` (webhooks source flow, source key `calcom`, integration id `webhook_source_calcom`). Requests are verified with the `x-cal-signature-256` header (lowercase hex HMAC-SHA256 of the raw body with the webhook secret).

## CRM setup

Per organization, in the integrations admin:

1. Enable the **Cal.com** integration.
2. Set the credentials:
   - **Webhook signing secret** (required) - each organization needs its own secret; the CRM syncs one inbound endpoint config per scope. A secret already used by another organization's active Cal.com endpoint is rejected: the endpoint stays off and a `calcom.endpoint.secret_in_use` error is written to the integration logs.
   - **Cal.com instance URL** (required), e.g. `https://cal.bluebee.marketing`.
   - **Unmatched attendee policy** - `create_person` (default) or `skip`.

Alternatively, configure from environment variables:

```bash
OM_INTEGRATION_CALCOM_WEBHOOK_SECRET=...        # required
OM_INTEGRATION_CALCOM_INSTANCE_URL=https://cal.example.com   # required
OM_INTEGRATION_CALCOM_UNMATCHED_POLICY=create_person         # optional: create_person | skip
OM_INTEGRATION_CALCOM_ENABLED=true                           # optional, default true

yarn mercato webhook_calcom configure-from-env --tenant <tenantId> --org <organizationId> [--force]
```

The same preset is applied automatically when a tenant is set up (`seedDefaults`). Existing credentials are kept unless `--force` is passed, so use `--force` to rotate the secret or change the instance URL. If only one of the two required variables is set, the command is skipped with a reason.

## cal.diy setup

### Recommended: one team webhook

Create **one team webhook** instead of one webhook per user. A team admin or owner opens the team settings, Developer, Webhooks (`/settings/developer/webhooks/new?teamId=<team id>`), and:

- **Subscriber URL**: `https://<crm-host>/api/webhooks/inbound/calcom`
- **Secret**: the same secret as configured in the CRM for that tenant/organization
- **Triggers**: `BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`, `MEETING_ENDED`, `RECORDING_TRANSCRIPTION_GENERATED`
- Switch **Include meetings of all team members** on.
- **Do not use a custom payload template** (nor Zapier-style payloads); the CRM parses the standard payload.

The team webhook only receives meetings whose notetaker results are **shared with that team** (sharing mode "team" with that team). Meetings shared with hosts only, with selected people, or not shared are never sent, and members who left the team stop matching. Use only this webhook for those members: combining it with per-user webhooks delivers the same meeting twice (the CRM de-duplicates, but it is wasted traffic).

### Alternative: per-user webhooks

Each host user can instead add a **user-level** webhook (Settings > Developer > Webhooks, `/settings/developer/webhooks/new`) with the same URL, secret and triggers. Transcripts are then only sent to the booking owner's user-level webhooks, so every host who should sync needs one. Prefer the team webhook above.

### Customer emails for ad-hoc meetings

Ad-hoc notetaker meetings (a meeting link added to the notetaker) and calendar auto-join meetings have no attendees. In the notetaker dialog (and in the meeting's notetaker section afterwards) the host can enter **Customer emails (optional)**. They are used only to match CRM people; they are not emailed. For calendar auto-join meetings the calendar attendees are used automatically. Changes made after the transcript was sent are not re-sent.

### `MEETING_ENDED` needs a cron

cal.diy only emits `MEETING_ENDED` from its scheduled-trigger job. Run a cron that calls `/api/cron/webhookTriggers` on the cal.diy instance, authenticated with the instance's `CRON_API_KEY` in the `Authorization` header (or `?apiKey=`):

```bash
curl -sSf -X POST https://<cal-host>/api/cron/webhookTriggers -H "authorization: $CRON_API_KEY"
```

(The route in this checkout exports `POST` only; `.github/workflows/cron-webhooks-triggers.yml` uses `-X POST`.)

### Transcripts

Transcripts need the cal.diy notetaker change (branch `feat/notetaker-crm-webhook`). cal.diy sends `RECORDING_TRANSCRIPTION_GENERATED` **once per transcript**, after the transcript is finalized and its summary has settled (or right away when no summary will be generated). The payload is the normal booking payload plus a `notetaker` block (passages and optional summary), so it can be several hundred KB.

## Transcripts for meetings without an event type

The cal.diy notetaker also records meetings that were never booked through an event type. The webhook payload then has `eventTypeId: null`, `type: "notetaker_meeting"`, the owner as organizer, attendees that may be empty, `metadata.videoCallUrl` set to the meeting URL, and an optional `source` field:

| `source` | Meaning |
|----------|---------|
| `booking` | Regular event-type booking (also the default when absent or unknown) |
| `ad_hoc` | Meeting link added manually to the notetaker |
| `calendar_auto_join` | Meeting joined automatically from a connected calendar |

The `notetaker` block is unchanged. `source` is optional and additive, older payloads keep working.

## Create from transcript

When a transcript arrives for a booking uid the CRM does not know:

1. CRM staff are removed from the attendee list.
2. The remaining attendees are matched to people by email, applying the **unmatched attendee policy** (`create_person` creates a person from the first unknown attendee; `skip` only uses existing people).
3. If a person is found or created, the meeting is created on that person **as done** (`occurredAt` = meeting end), the transcript is attached as a `.txt` and the summary (when `READY`) is posted as a comment, exactly like transcripts for known bookings.
4. If there is no usable person, the transcript is queued in the **Unassigned transcripts** inbox instead of being dropped.

Soft-deleted CRM meetings are still skipped. Redelivery of the same transcript is a duplicate.

## Unassigned transcripts inbox

Location: **Customers > Unassigned transcripts** (`/backend/unassigned-transcripts`).

A transcript lands here when create-from-transcript cannot choose a person:

- `no_attendees`: the meeting has no attendees (typical for ad-hoc and auto-join meetings without customer emails).
- `no_matching_attendee`: attendees exist but none matches a person and none can be created (policy `skip`, or every attendee is CRM staff).

Each row shows meeting date, title, source, participants, reason and when it was received. The detail page shows the summary and a preview of the first 200 transcript lines.

- **Access**: `webhook_calcom.transcripts.view` lists and opens rows, `webhook_calcom.transcripts.manage` assigns and dismisses. Both are granted to the `admin` (via `webhook_calcom.*`) and `employee` roles. Assigning also needs `customers.interactions.manage` and `customers.people.view`, and the chosen person must be in the same organization.
- **Notifications**: a new row sends an in-app notification, restricted to users of that organization who hold `webhook_calcom.transcripts.manage`.
- **Assign**: pick a contact in the dialog. The meeting is created on that contact as done, with the transcript attached and the summary comment. If the booking's own webhook arrived after the transcript was queued, the transcript is attached to that **existing meeting** instead of creating a second one. The row is marked resolved.
- **Dismiss**: removes the row permanently (single or bulk).
- **Optimistic locking**: assigning sends the row's `updatedAt`; if someone else handled the row meanwhile the API returns 409 and the UI shows the conflict bar.

API: `GET /api/webhook_calcom/unassigned-transcripts`, `DELETE /api/webhook_calcom/unassigned-transcripts` (dismiss), `GET /api/webhook_calcom/unassigned-transcripts/<id>`, `POST /api/webhook_calcom/unassigned-transcripts/<id>/assign` with `{ "personId": "<uuid>" }`. Transcript contents are stored encrypted.

## Matching rules

- **CRM staff are excluded first**: attendees whose email belongs to a CRM user are dropped (for `BOOKING_*` and transcripts alike), so an internal colleague never becomes the meeting's person.
- Remaining attendees are matched to people by email; the **first known attendee** becomes the meeting's person and other known attendees are linked.
- If no attendee matches and the policy is `create_person`, a person is created from the **first attendee** (`source: calcom`); other unknown attendees stay plain participants. With `skip` the booking is skipped.
- The organizer is matched to a CRM **user by email** (owner/author of the interaction).
- Reschedules are located through the old booking uid (`rescheduleUid`) and mapped to the new uid.

## Idempotency

- Deliveries are de-duplicated on `calcom:<trigger>:<uid>:<createdAt>` (`MEETING_ENDED`: `calcom:MEETING_ENDED:<uid>`).
- Writes run under a per-organization lock. The booking uid is mapped to the interaction through the external id mapping service, with a deterministic UUID as fallback.
- Replays update scheduling fields only and never downgrade a terminal status. Each transcript is attached once (`<uid>:transcript:<transcriptId>`).

## Limits

- Request bodies up to **2 MiB** are accepted for this source (`maxBodyBytes`).
- `BOOKING_*` and `MEETING_ENDED` are not sent for ad-hoc and calendar auto-join meetings; only their transcript is.
- Deletions in cal.diy do not propagate to the CRM; soft-deleted CRM meetings are skipped.
- Cancelling or rejecting an already completed meeting is ignored.
- No company matching.

## Troubleshooting

- **401 on delivery**: the signature did not verify (wrong or missing secret, mismatched per-tenant secret) or the integration is disabled/not configured for that organization.
- **413**: body above the source limit.
- **Endpoint stays inactive with `calcom.endpoint.secret_in_use`** in the integration logs: another organization's active Cal.com endpoint already uses the same webhook secret. Deliveries are matched to an organization by the secret, so duplicates are refused. Set a distinct secret for this organization (in the CRM and in cal.diy) and save the credentials again to re-sync.
- Check the **webhook ingestion log** in the webhooks admin for received deliveries and their status, and the **integration logs** of the Cal.com integration for per-delivery outcomes (`created`, `updated`, `canceled`, `completed`, `skipped` with a reason such as `no_matching_attendee`, `booking_not_found`, `already_terminal`, `integration_disabled`, `credentials_missing`).
- The integration health check reports missing credentials and whether the instance URL is reachable.
- Meetings never complete: the `MEETING_ENDED` cron is not running or the key is wrong.
- No transcripts: no team webhook (with **Include meetings of all team members**) or user-level webhook subscribes to `RECORDING_TRANSCRIPTION_GENERATED`, the meeting's notetaker results are not shared with the team, or the cal.diy notetaker change is not deployed.
- A transcript sits in the inbox: see the **Unassigned transcripts** section for the reason.

## Development

```bash
yarn workspace @open-mercato/webhook-calcom test
```
