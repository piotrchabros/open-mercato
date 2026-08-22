# Connect successor write-path ledger

Scope: the nine `2026-08-21-connect-*` successor specifications. Counted after two consecutive four-role dry rounds.

| Spec | Headline write requirements | Performing tasks |
|---|---:|---|
| Foundation | 10 | FDN-FR-001/002/003/004/005/006/007/008/009/010 → FDN-DATA-01/02, FDN-DOM-01, FDN-ING-01/02/03/04, FDN-GUARD-01; lifecycle writes continue through INB-CMD-02 |
| Inbox | 9 | INB-FR-002/005/005A/006/007/008/009/010/011 → INB-DATA-01/02, INB-CMD-01/02, INB-API-01, INB-SEND-01/01A/01B/02/03/04, INB-UI-01/02 |
| Customer Projection | 8 | PROJ-FR-001..008 → PROJ-ING-02, PROJ-CMD-01/02, PROJ-WRK-01/02/03, plus Inbox resolve outbox writer INB-CMD-02/INB-EVT-01 |
| Operational Metrics | 5 | MET-SC-001..005 → source FDN/INB/PROJ event writers plus MET-WRITE-01, MET-AGG-01, MET-WRK-01 |
| Upstream Contract B | 5 | deterministic create, retraction-group inventory, monotonic saga, hidden/tombstoned visibility, trusted write context → CUS-UP-01/02 |
| Upstream Contract A | 6 | scoped actor, isolation, shared credential, correlation↔attempt binding, outcome revision, mutation guards → SND-UP-01/02/03 plus Contract E credential tasks |
| Upstream Contract E | 6 | organization owner, owner freeze, exclusive projection mode, capability cutover, active membership, last-manager serialization → AUTH-UP-01/02/EMAIL-01/GMAIL-01/RECOVER-01 |
| Upstream Contract C | 0 | Read-only contract; THR-UP-01/02 perform no durable write |
| Upstream Contract D | 0 | Read-only contract; FDN-ING-01 and INB-SEND-01A own downstream writes |

Detailed mapping notes:

- Receipt claim, Case decision, conversation reply provenance, identity state, and unresolved-identity event commit through FDN-ING-01/FDN-EVT-01.
- Logical outbound message, attempt, correlation, reply target, and DB outbox commit through INB-SEND-01/01A; dispatch/reconciliation/retry have distinct tasks.
- Resolve writes its domain-outbox intent through INB-CMD-02/INB-EVT-01; Projection materializes and drains through PROJ-ING-02/PROJ-WRK-01.
- Unlink/retraction writes use PROJ-CMD-02 and the ordinary/recovery workers, backed by Contract B's source-owned inventory and saga writers.
- Metrics never writes source state; MET-WRITE-01/AGG-01/WRK-01 own idempotent facts and aggregates.

Counts: **49 headline write requirements; 49 with a performing task; 0 unmapped; 0 stale task references.** Read/security-only requirements remain covered by their API/test tasks but are not counted as durable writes.
