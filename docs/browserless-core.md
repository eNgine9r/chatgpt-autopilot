# Browserless Autopilot Core

## Goal
Make Chromium optional. Healthy idle state performs zero ChatGPT page loads and zero OpenAI API calls.

## Runtime
- Python standard library only.
- SQLite WAL durable state.
- Event-driven queue with idempotency keys and per-project serialization.
- OpenAI Responses API model is fixed to `gpt-5.6-luna` in v1.
- No silent model escalation.
- Missing credential, budget exhaustion, malformed model output, or ambiguous evidence fail closed.

## Context contract
Only the governed Plan Anchor, compact durable checkpoint, bounded event summary/metadata, and bounded fresh evidence are sent. Full chat history and raw logs are deliberately excluded.

## Cost control
Every call has a conservative preflight against a configurable monthly hard budget. Usage tokens returned by the Responses API are recorded durably for spend estimation. No event means no request and therefore no tokens.

## Safety
Browser fallback remains disabled during Browserless development. Autopilot must not perform product trading, hardware/Modbus writes, or unapproved production/site cutovers.
