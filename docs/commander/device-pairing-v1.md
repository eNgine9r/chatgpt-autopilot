# Commander Device Pairing v1

The Phase 11 foundation separates human identity from machine identity.

## Device identity

The Agent keeps its existing stable `deviceId` and adds a private Ed25519 keypair. The keypair file is private (0600) inside a private state directory (0700). The public key fingerprint is SHA-256 over the SPKI DER representation.

## Pairing request

`CommanderPairingService.createRequest` accepts a stable device ID and public key and returns:

- opaque `requestId`;
- high-entropy `deviceCode` for the Agent only;
- short human `userCode`;
- verification URL;
- expiry timestamp.

Only SHA-256 hashes of the user/device codes are stored. Requests expire automatically and approval/rejection is single-use.

## Approval

The future operator adapter authenticates a human (Google OIDC first) and calls `approve(userCode, operator)`. The trust store records provider subject/email metadata plus the device public-key fingerprint. The Agent never receives a Google token.

## Registration migration

With `COMMANDER_PAIRING_AUTH_ENABLED=true`, an Agent signs the existing Commander challenge using its Ed25519 private key. The Gateway may verify either the paired key or the legacy HMAC secret during migration. Default configuration remains HMAC-only until an explicit rollout.
