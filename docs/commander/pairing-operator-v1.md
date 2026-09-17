# Commander Pairing Operator v1

## Device flow

Run `npm run commander:register` with `COMMANDER_PAIRING_BASE_URL` set to the private operator endpoint. The command loads the stable Commander device ID and Ed25519 keypair, requests pairing, prints the verification URL and code, then polls with the opaque device code until approval, rejection or expiry.

Optional `COMMANDER_PAIRING_SCOPES` is a comma-separated review list such as `project:nexolab,capability:file.read`. These values are metadata for the operator; they never enable a Commander capability.

## Operator flow

The operator service is disabled by default. With OIDC configured, `/auth/login` starts Authorization Code + PKCE. After callback validation, `/device` accepts the one-time code, shows device ID, display name, public-key fingerprint and requested scopes, and exposes CSRF-protected Approve/Reject actions. Trusted devices can later be revoked from the same page.

## Deployment boundary

Initial acceptance permits only loopback or an exact address assigned to `tailscale0`; wildcard, LAN and Funnel binds are rejected by the existing private-bind gate. OIDC issuer, client ID and optional client secret live only in the private environment file. Merging Phase 13 does not start or enable the operator service.
