# `cli/` — `@antbot/cli`

**The `antbot` command.** The only binary the package installs, and how you start, inspect and
maintain the daemon.

```
antbot doctor     antbot start|stop|restart|status     antbot open
antbot skill      antbot backup|restore                antbot update
```

## Why it is a separate package from the daemon

So that `antbot doctor` works when the daemon does not. Doctor's whole job is diagnosing a broken
install — a missing `claude` CLI, an unbuilt UI, a `better-sqlite3` that will not load — and it
cannot do that if importing the daemon is what crashes.

Everything that touches `@antbot/daemon` therefore goes through **`src/serverBridge.ts`**, which
imports it lazily and degrades to a readable error. That file is also where the layout-independent
package resolution lives, so an installed copy finds its own dependencies.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Command dispatch |
| `src/args.ts` | Hand-rolled parser — no CLI framework |
| `src/doctor.ts` | `runDoctor(deps)`, with every filesystem/network/subprocess call injected |
| `src/daemon.ts` | start/stop/status, pidfile handling |
| `src/serverBridge.ts` | The lazy boundary to `@antbot/daemon` |
| `src/backup.ts` | `computeBackupItems` (pure) + tar archive/restore |
| `src/update.ts` | Version compare, package-manager detection, the cached registry check |
| `src/skill.ts` | `antbot skill` subcommands |

The pure-core/injected-edges split in `doctor.ts` and `backup.ts` is the pattern to follow for
anything new here — it is what makes them testable without a daemon.

Depends on: `@antbot/contract`, and `@antbot/daemon` **lazily**.
