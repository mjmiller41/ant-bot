# `ui/` — `@antbot/ui`

**The web interface**, at `http://127.0.0.1:4780`. React 19 + Vite + Tailwind v4.

There is no separate frontend server in normal use: `pnpm build` emits `ui/dist/`, and the daemon
serves it as static files. `pnpm --filter @antbot/ui dev` runs Vite with hot reload against a
daemon on :4780 when you are working on the UI itself.

## Layout

| Path | Contents |
|---|---|
| `src/App.tsx` | Shell and screen routing (in-app state — there is no URL router) |
| `src/components/` | Thread view, composer, approval cards, bot settings, screens |
| `src/store/` | The single Zustand slice and `handleServerEvent` |
| `src/api/` | REST client and the websocket connection |
| `e2e/` | Playwright specs — need a live daemon, not run in CI |

## Two conventions that bite

**The app owns the viewport.** `body` has `overflow: hidden` and the shell is `h-dvh`. Any flex
child meant to scroll needs **`min-h-0`** next to `flex-1` — without it the child sizes to its
content and pushes the composer off screen.

**Skill descriptions are long and untrimmable.** Published skills pack trigger phrases into
`description` because that is what the model matches on. Any row showing one must clamp it, never
let it set row height.

Styling is Tailwind v4 with CSS custom properties (`bg-(--color-bg-elevated)`); tokens live in
`src/index.css`. Use them rather than raw hex.

Depends on: `@antbot/contract`.
