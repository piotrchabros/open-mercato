# Connect successor out-of-scope/core-edit ledger

Repository rule quoted from the runbook: **“Rows (d) and (e) must each state why the sanctioned extension route was rejected, and must ship as a separate upstream PR merged before the consuming PR.”** The root `Ask First` boundary also covers public-contract and multi-module changes. BC permits additive tables, defaulted columns, DI registrations, and optional fields; existing identifiers/signatures are not removed or narrowed.

| Outside-Connect surface | Class | Why extension-only is insufficient | Ships as |
|---|---|---|---|
| Workspace/app/create-app/TS/Jest/generator registrations | b | Additive discovery only | Foundation PR |
| Shared-channel organization, membership, projection mode | d | Source channel must atomically own credential/delivery scope and mode | Contract E upstream PR |
| Shared-channel ACL/authorization/cutover | b/e | Authority must be enforced by the source module | Contract E upstream PR |
| Gmail/IMAP capability and provision/recovery behavior | c/e | Provider credential lifecycle cannot be enforced by Connect extension data | Contract E upstream PR |
| Customers legacy subscribers skip Connect-managed channels | e | Only source subscribers can prevent duplicate/unretractable projections | Contract E upstream PR |
| Inbound envelope/reply-target facade | a/e | No sanctioned cross-module read extension exists; peer-table reads are forbidden | Contract D upstream PR |
| Envelope/reply DI and public schemas | b | Additive bounded service registration | Contract D upstream PR |
| Thread reader implementation | a/e | Source must authorize/decrypt/project system-authored messages | Contract C upstream PR |
| Thread reader DI/public types | b | Additive bounded service registration | Contract C upstream PR |
| Send input/adapter optional fields | c | Optional, legacy behavior unchanged | Contract A upstream PR |
| Hub correlation↔attempt storage | d | Dedupe must be atomic with the source delivery owner | Contract A upstream PR |
| Hub delivery behavior/outcome/status lookup | b/e | Sole provider caller must own authorization and outcome fencing | Contract A upstream PR |
| Customer reference/retraction service | a/b | Source facade replaces forbidden customer-entity access | Contract B upstream PR |
| Customer retraction saga/group storage | d | Only Customers can atomically hide and inventory its timeline rows | Contract B upstream PR |
| Customer timeline readers exclude hidden/tombstoned | e | Only source readers can enforce global non-disclosure | Contract B upstream PR |
| Public-contract/BC documentation | docs | Freezes additive surfaces with their owning release | Contracts A–E |

Counted class instances: **26 total** — 4 class (a), 5 class (b), 2 class (c), **3 class (d)**, **7 class (e)**, and 5 documentation surfaces. All 10 (d)/(e) instances state why the sanctioned alternative is insufficient and are assigned to separately released upstream Contracts A–E.
