# ADR-011 — Commander Human Identity and Device Pairing Trust

- Status: Accepted for Phase 11 foundation
- Date: 2026-09-17
- Tracking issue: #353

## Context

The Phase 2 Agent session uses a per-device HMAC secret provisioned on both Agent and Gateway. That remains a safe fallback, but it is not the desired operator experience for an RDC replacement. Commander needs an operator-approved device flow where the device owns its credential and a human signs in separately.

## Decision

Add an opt-in asymmetric trust path without removing legacy HMAC registration.

Each Agent owns an Ed25519 keypair stored mode 0600. The private key never leaves the device. Pairing creates a short-lived one-time user code plus a high-entropy device code. The server stores only hashes of those codes. After an authenticated human approves the user code, the Gateway trust store binds the stable Commander `deviceId` to the Agent public key fingerprint and the operator identity.

Normal Commander session registration continues to use the existing challenge. A paired Agent signs the same canonical challenge payload with Ed25519; the Gateway verifies it against the trusted public key. HMAC and Ed25519 can coexist during migration. `COMMANDER_PAIRING_AUTH_ENABLED` is disabled by default.

Google/OIDC authenticates the human operator only. Google credentials or OAuth tokens must never become the Agent credential and must never be sent to the Agent. The provider/web adapter is a separate follow-up layer over the pairing service.

## Revocation and rotation

A revoked trust record no longer resolves a public key, so subsequent registrations fail closed. Key rotation for an already trusted device is rejected until the old trust record is explicitly revoked. A later admin adapter must also disconnect an already-active revoked session immediately.

## Consequences

- Device compromise does not expose a Google credential.
- Gateway database compromise does not reveal Agent private keys or raw pairing codes.
- Existing HMAC deployments remain compatible.
- No HTTP/OIDC listener or production activation is introduced by the foundation PR.
