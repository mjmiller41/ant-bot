import type { Command } from './args.js';

export const GLOBAL_HELP = `antbot — a local daemon and web UI for a roster of persistent Claude teammates.

Usage: antbot <command> [options]

Getting started:
  antbot doctor        Check your environment (Node, claude CLI + login, data dir, port)
  antbot open          Open the web UI, starting the daemon if it isn't running

Daemon:
  start [options]      Start the daemon in the background
  stop                 Stop the daemon
  restart [--port N]   Stop and start again
  status               Show whether the daemon is running, and where
  open                 Open the web UI (starts the daemon first if needed)
  doctor               Diagnose the local environment

Data:
  skill <subcommand>   Manage the skills your bots can use
  backup [--out PATH]  Archive the database, config, skills, and bot memory
  restore <path>       Restore from a backup archive

Options:
  -h, --help           Show help; "antbot <command> --help" for one command
  -v, --version        Show the CLI version

Environment:
  ANTBOT_HOME          Data directory (default: ~/.ant-bot)

The UI lives at http://127.0.0.1:4780 and is served by the daemon itself.`;

const COMMAND_HELP: Record<Command, string> = {
  start: `antbot start — start the daemon in the background

Usage: antbot start [--port N] [--open] [--foreground]

  --port N       Port to listen on (default: from config, usually 4780)
  --open         Open the web UI once the daemon is healthy
  --foreground   Run in this terminal instead of detaching (Ctrl-C stops it)

Detached output goes to the log in your data directory; "antbot status" tells
you where that is. Starting an already-running daemon is a no-op.`,

  stop: `antbot stop — stop the daemon

Usage: antbot stop

Sends SIGTERM, then SIGKILL if it hasn't exited after 10 seconds. Stopping a
daemon that isn't running succeeds quietly.`,

  restart: `antbot restart — stop the daemon and start it again

Usage: antbot restart [--port N]

  --port N   Port to listen on when starting back up

Bots, threads, and memory survive a restart.`,

  status: `antbot status — show daemon status

Usage: antbot status

Prints the URL, version, data directory, and bot count. Exits non-zero when the
daemon is not running, so it works in scripts.`,

  doctor: `antbot doctor — diagnose the local environment

Usage: antbot doctor

Checks Node.js version, the claude CLI, Claude authentication, ANTHROPIC_API_KEY,
data directory permissions, port availability, better-sqlite3, and Playwright's
Chromium install. Each failure prints the command that fixes it.

Exits non-zero if any check fails.`,

  open: `antbot open — open the web UI

Usage: antbot open

Prints the URL and hands it to your browser. If the daemon isn't running yet,
it is started first — so this is the only command you need day to day.`,

  skill: `antbot skill — manage the skills your bots can use

Usage:
  antbot skill list
  antbot skill add <source>
  antbot skill remove <slug>

A skill is a directory containing a SKILL.md. \`add\` accepts:

  owner/repo                        a GitHub repository
  github.com/owner/repo             the same, written out
  github.com/owner/repo#v2          pinned to a branch or tag
  github.com/owner/repo/tree/main/x one skill inside a monorepo
  git@github.com:owner/repo.git     any git URL
  ./path/to/skill                   a local directory
  https://host/path/SKILL.md        a single skill file

A repository holding several skills installs all of them. Re-installing an
existing skill upgrades it in place and keeps it assigned to its bots.

Skills committed to the ant-bot project's own skills/ directory are installed
automatically on every start.`,

  backup: `antbot backup — create a backup archive

Usage: antbot backup [--out PATH]

  --out PATH   Output path for the tar.gz (default: ~/.ant-bot/backups/<timestamp>.tar.gz)

Includes antbot.db, config.toml, skills, and each bot's memory directory.
Excludes browser-profile and attachments.`,

  restore: `antbot restore — restore from a backup archive

Usage: antbot restore <path> [--yes]

  --yes   Skip the confirmation prompt

Overwrites files in your data directory. Stop the daemon first.`,
};

export function commandHelp(command: Command): string {
  return COMMAND_HELP[command];
}
