# ADR-012 — Commander Pairing Operator and OIDC Boundary

- Status: Accepted for Phase 13 implementation
- Date: 2026-09-17
- Tracking issue: #409

## Decision

Commander adds a separate operator-facing pairing service. It is an adapter over `CommanderPairingService` and `CommanderTrustStore`; it is not part of Agent execution authority and cannot grant runtime capabilities. Initial deployment is loopback or exact `tailscale0` bind only.

Human authentication uses OIDC Authorization Code with PKCE, `state`, `nonce`, signed ID-token verification and CSRF-protected operator actions. Google is the first configured provider, but the adapter consumes standard discovery/JWKS metadata. Google credentials never reach the Agent.

The device calls only `POST /api/device/pair` and `POST /api/device/status`. The human enters the short code after authentication, reviews device identity, fingerprint and requested scopes, then approves or rejects. Approval stores the Ed25519 public-key trust record. Requested/approved scopes are review metadata only; Gateway/Agent capability and policy checks remain authoritative.

## Security boundaries

- no public Agent listener;
- no generic shell or ADMIN authority;
- pairing and trust files remain 0600 under a 0700 state directory;
- one-time codes expire and are rate-limited;
- operator sessions are bounded, HttpOnly, SameSite=Strict and Secure when HTTPS is used;
- production activation and OIDC credentials are local runtime configuration, not repository content.

## Consequences

Commander can reproduce the RDC-style `URL + code + sign-in + approve` bootstrap while keeping machine trust, human identity and ChatGPT/MCP integration as separate boundaries.
