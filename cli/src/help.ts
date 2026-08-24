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
  mcp <subcommand>     Manage the MCP servers your bots can use
  backup [--out PATH]  Archive the database, config, skills, and bot memory
  restore <path>       Restore from a backup archive

Maintenance:
  update [--check]     Update ant-bot to the latest published version

Options:
  -h, --help           Show help; "antbot <command> --help" for one command
  -v, --version        Show the CLI version

Environment:
  ANTBOT_HOME          Data directory (default: ~/.ant-bot)

The UI lives at http://127.0.0.1:4780 and is served by the daemon itself.`;

/** `mcp` and its older alias `connector` share one help text. */
const MCP_HELP = `antbot mcp — manage the MCP servers your bots can use

Usage: antbot mcp <subcommand>

  list                    Show every server, with warnings for anything unusable
  add <name> ...          Add one: --stdio "<cmd>" or --url <url>
  login <name>            Sign in interactively (http/sse servers that need OAuth)
  logout <name>           Forget a stored sign-in
  enable|disable <name>   Turn one on or off for every bot at once
  remove <name>           Delete it, and every bot's assignment to it
  test <name>             Connect and list the tools it offers

A server is registered once for the account and then assigned to individual bots in
Bot settings — a bot with no assignment cannot see its tools at all. Its tools reach
bots as \`mcp__<name>__<tool>\` and pass the permission gateway like any other tool,
so the first call asks you for approval.

Credentials, two ways. A static token goes in a header or an env var, written as
{{secret:NAME}} so the value stays in your keychain:

  antbot mcp add fs --stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"
  antbot mcp add gh --url https://api.example.com/mcp \\
    --header "Authorization=Bearer {{secret:GH_TOKEN}}"

A server that wants an interactive sign-in instead uses \`login\`, which discovers
what it accepts and prints a URL to open:

  antbot mcp login gmail

Providers that support dynamic client registration need nothing else. Some — Google
among them — do not, and want a client ID you create in their console, with
http://127.0.0.1:4780/api/connectors/oauth/callback as an authorised redirect URI:

  antbot mcp login gmail --client-id YOUR_ID.apps.googleusercontent.com

\`connector\` is the older name for this command and still works.`;

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
  antbot skill lint [path]

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
automatically on every start.

\`lint\` checks skills against the Agent Skills spec (skills/SPEC.md) and needs
no running daemon. With no path it checks everything installed; give it a path
to check one skill you are still writing, or a directory of them:

  antbot skill lint                 every installed skill
  antbot skill lint ./skills        a directory of skills
  antbot skill lint ./skills/my-skill   one skill

Exit status is 1 if anything is an error, 0 if only warnings.`,

  backup: `antbot backup — create a backup archive

Usage: antbot backup [--out PATH]

  --out PATH   Output path for the tar.gz (default: ~/.ant-bot/backups/<timestamp>.tar.gz)

Includes antbot.db, config.toml, skills, and each bot's memory directory.
Excludes browser-profile and attachments.`,

  update: `antbot update — update ant-bot to the latest published version

Usage: antbot update [--check] [--yes]

  --check   Report whether a newer version exists and exit; change nothing
  --yes     Skip the confirmation prompt

Runs the package manager that installed this copy, then restarts the daemon if
it was running. The check is cached for a day, so it costs no network most of
the time. ant-bot never updates itself in the background: the daemon holds a
live database handle and may be mid-turn.

In a git checkout there is nothing for a package manager to update — use
\`git pull && pnpm install\` instead.`,

  connector: MCP_HELP,
  mcp: MCP_HELP,

  restore: `antbot restore — restore from a backup archive

Usage: antbot restore <path> [--yes]

  --yes   Skip the confirmation prompt

Overwrites files in your data directory. Stop the daemon first.`,
};

export function commandHelp(command: Command): string {
  return COMMAND_HELP[command];
}
