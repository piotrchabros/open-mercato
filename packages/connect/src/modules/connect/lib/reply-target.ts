/**
 * Contract D reply-target constants, mirrored locally.
 *
 * Connect imports the hub's DI facade, not its source: importing a peer module's
 * internals would be exactly the cross-module coupling the boundary rules forbid.
 * The version is a small, stable number that Contract D refuses to resolve
 * against if it drifts, so a mismatch fails closed rather than silently
 * resolving a reference under the wrong policy.
 */
export const INBOUND_REPLY_REF_SOURCE_VERSION = 1
