# `contract/` — `@antbot/contract`

**The shared vocabulary. Everything else depends on this; it depends on nothing.**

Zod schemas and TypeScript types for every entity (`Bot`, `Thread`, `Message`, `Approval`,
`Rule`, `Skill`, `Routine`), every API request and response, the `ServerEvent` union that flows
over the websocket, and the `LIMITS` constants.

## Why it exists

The daemon and the UI have to agree on the shape of every message that crosses between them. If
each declared its own `Bot` type, they would drift, and the first symptom would be a runtime
error in the browser. So there is exactly one declaration of each, here, and both sides import it.

**The rule: never redeclare a shared type on one side.** If the daemon and the UI both need to
know something, it belongs in this package. Nothing here may import from `daemon/` or `ui/`.

Zod rather than plain types, because these shapes cross a network boundary and have to be
*validated*, not just annotated — the daemon parses request bodies with these schemas.

## Files

| File | Contents |
|---|---|
| `entities.ts` | The domain objects, `MODEL_TIERS`, and their schemas |
| `api.ts` | Request/response shapes for every route |
| `events.ts` | The `ServerEvent` union pushed over `/api/events` |
| `limits.ts` | `LIMITS` constants and `LimitError` |

Depends on: **zod**, and nothing else.
