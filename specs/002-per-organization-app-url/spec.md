# Feature Specification: Per-Organization Application Address

**Feature Branch**: `002-per-organization-app-url`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "osobny APP_URL dla każdej organizacji" (a separate APP_URL for each organization)

## Context

One CRM installation serves several organizations, each reached under its own web address (for example `crm.bluebee.marketing` for BlueBee, `crm.bespokesoft.pl` for Bespokesoft, `crm.staffinit.com` for Staffinit). Today the installation has a single public address. Every address the system generates on its own — links in emails (password reset, invitations, notifications), sign-in callback addresses for connected services (Meta Lead Ads, OAuth integrations), and links in generated documents — points to that one address, regardless of which organization the recipient belongs to.

On 2026-11-05 the single address was switched from `crm.bespokesoft.pl` to `crm.bluebee.marketing` so that BlueBee could connect Meta Lead Ads. As a side effect, Bespokesoft and Staffinit users now receive links to the BlueBee address. This feature lets each organization have its own address, so generated links and service connections use the address of the organization they belong to.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Emails link to the recipient's organization address (Priority: P1)

A user of the Bespokesoft organization asks for a password reset (or is invited, or receives a notification email). The link in the email opens the CRM under `crm.bespokesoft.pl`, the address that user knows and normally signs in on, and not under another organization's address.

**Why this priority**: This is the visible harm of the current setup: users of one company receive links branded with another company's address, which looks like phishing, confuses users, and leaks which organizations share the installation.

**Independent Test**: Configure different addresses for two organizations, trigger a password reset for a user of each, and check that each email links to that user's organization address and that the link works.

**Acceptance Scenarios**:

1. **Given** Bespokesoft has the address `https://crm.bespokesoft.pl` and BlueBee has `https://crm.bluebee.marketing`, **When** a Bespokesoft user requests a password reset, **Then** the reset link starts with `https://crm.bespokesoft.pl` and completing the reset works.
2. **Given** the same setup, **When** an administrator of BlueBee invites a new user to BlueBee, **Then** the invitation link starts with `https://crm.bluebee.marketing`.
3. **Given** an organization has no address configured, **When** one of its users receives an email with a link, **Then** the link uses the installation's default address (today's behaviour).

---

### User Story 2 - Connecting an external service works from the organization's own address (Priority: P1)

An administrator signed in on `crm.bluebee.marketing` clicks "Connect with Meta" (or connects another service that signs in through the provider's website). After approving access on the provider's site, they come back to `crm.bluebee.marketing`, still signed in, and the connection is saved to BlueBee. An administrator of Bespokesoft does the same on `crm.bespokesoft.pl` and comes back there.

**Why this priority**: Today a connection only succeeds when started on the single installation address; started anywhere else it fails after the provider's approval screen because the user returns to an address where they are not signed in. This blocks each organization from connecting its own accounts.

**Independent Test**: With two organizations on different addresses, start a service connection from each address and confirm both complete and are stored for the right organization.

**Acceptance Scenarios**:

1. **Given** BlueBee's address is `https://crm.bluebee.marketing`, **When** a BlueBee administrator signed in there connects Meta Lead Ads, **Then** the provider returns them to `https://crm.bluebee.marketing` and the connection is listed under BlueBee.
2. **Given** Bespokesoft's address is `https://crm.bespokesoft.pl`, **When** a Bespokesoft administrator connects the same type of service there, **Then** they return to `https://crm.bespokesoft.pl` and the connection is listed under Bespokesoft only.
3. **Given** the provider only accepts return addresses registered in advance, **When** an administrator views the connection settings, **Then** the system shows the exact return address that must be registered with the provider for that organization.

---

### User Story 3 - A super administrator sets an organization's address (Priority: P2)

A super administrator opens the organization's settings and chooses its public address from the addresses the installation is allowed to serve. The change takes effect for new emails and new connections without restarting the system.

**Why this priority**: Needed to set up and change addresses, but the first two stories already deliver value if addresses are seeded once by an operator.

**Independent Test**: Change an organization's address in the settings, then trigger a password reset for one of its users and confirm the new address is used, without any restart.

**Acceptance Scenarios**:

1. **Given** a super administrator, **When** they set BlueBee's address to `https://crm.bluebee.marketing`, **Then** it is saved and the next email for a BlueBee user uses it.
2. **Given** an address that the installation is not allowed to serve, **When** a super administrator tries to save it, **Then** the save is rejected with a clear message and nothing changes.
3. **Given** an organization administrator who is not a super administrator, **When** they open the organization's settings, **Then** they can see the address but cannot change it.
4. **Given** an address already assigned to another organization, **When** a super administrator tries to assign it to a second organization, **Then** the save is rejected.

---

### Edge Cases

- A user belongs to, or can switch between, several organizations: an email about a specific organization's record uses that organization's address; an email about the account itself (password reset, invitation) uses the address of the organization the account belongs to, falling back to the installation default.
- A process runs with no organization in context (system-wide emails, installation-level jobs): it uses the installation default address.
- An organization's address is changed while a service connection is in progress: the in-flight connection completes against the address it started on, or fails with a clear "start again" message; it never attaches to another organization.
- A request arrives on an address that belongs to a different organization than the signed-in user's selected organization: generated links and connection return addresses never mix organizations; the system uses the organization in context and only addresses allowed for it.
- An organization's address is removed: the organization falls back to the installation default address.
- Links already sent before an address change keep pointing to the old address; the old address keeps working as long as it is still served by the installation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow each organization to have at most one public address (scheme and host), optional per organization.
- **FR-002**: The system MUST keep an installation-wide default address, used for organizations without their own address and for processes with no organization in context.
- **FR-003**: Every link the system generates for a specific organization (password reset, invitation, account and security emails, notification emails, onboarding emails, links inside generated documents) MUST use that organization's address when it has one.
- **FR-004**: Return addresses used when connecting external services through the provider's website MUST use the address of the organization the connection is being made for.
- **FR-005**: The system MUST show administrators, for each connectable service, the exact return address to register with the provider for their organization.
- **FR-006**: Only super administrators MUST be able to set, change, or remove an organization's address; other administrators MAY view it.
- **FR-007**: The system MUST only accept an organization address that is on the installation's list of addresses it is allowed to serve, and MUST reject an address already assigned to another organization.
- **FR-008**: A change of an organization's address MUST take effect for new emails and new connections within one minute, without restarting the system.
- **FR-009**: The system MUST NOT generate a link or return address for one organization that points to an address assigned to another organization.
- **FR-010**: Every change of an organization's address MUST be recorded in the audit log with who changed it, when, and the old and new value.
- **FR-011**: Existing installations with no per-organization addresses configured MUST behave exactly as today (all links use the installation default address).

### Key Entities

- **Organization address**: the public address (scheme and host) of one organization; belongs to exactly one organization; optional; unique across organizations; must be among the addresses the installation is allowed to serve.
- **Installation default address**: the single address used when an organization has no address of its own or when no organization is in context (today's only address).
- **Allowed addresses**: the operator-controlled list of addresses this installation serves; an organization address can only be chosen from it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With addresses configured for BlueBee, Bespokesoft, and Staffinit, 100% of password reset, invitation, and notification emails sent to users of each organization link to that organization's address.
- **SC-002**: An administrator of each of the three organizations can complete a Meta Lead Ads connection starting from their own organization's address on the first attempt, with no "session expired" or "state mismatch" failure.
- **SC-003**: Zero generated links or connection return addresses point to another organization's address (verified across a test sample covering every email type and every connectable service).
- **SC-004**: A super administrator can change an organization's address in under 2 minutes, and the next email sent for that organization uses the new address without any restart.
- **SC-005**: On an installation with no organization addresses configured, all existing email, connection, and document link tests pass unchanged.

## Assumptions

- The web server already routes each organization's address to this installation (Caddy serves `crm.bluebee.marketing`, `crm.bespokesoft.pl`, `crm.staffinit.com`, and the `admin.*` hosts today); this feature does not provision domains, DNS, or TLS certificates.
- The operator-controlled allowed address list (today `APP_ALLOWED_ORIGINS`) remains the source of which addresses may be used; the installation default address stays configured by the operator (today `APP_URL`).
- Only super administrators manage organization addresses, because the address decides where password reset and sign-in links send users; letting any organization administrator change it would be a phishing risk.
- Customer portal custom domains (the existing portal domain mappings) are a separate concern and stay unchanged; the organization address applies to the staff back office.
- Registering return addresses with each external provider (for example adding `https://crm.bluebee.marketing/api/meta_lead_ads/oauth/callback` in the Meta app settings) stays a manual step for the administrator; the system only shows the value to register.
- After rollout, the production default address can be set back to a neutral value once each organization has its own address.
