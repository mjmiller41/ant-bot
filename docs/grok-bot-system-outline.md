# Grok Bot — System Feature & Functionality Outline

> Research notes compiled 2026-08-20 from primary sources: the product page
> ([x.ai/bot](https://x.ai/bot)), the launch announcement
> ([x.ai/news/introducing-grok-bot](https://x.ai/news/introducing-grok-bot), Aug 11 2026), and the
> full product documentation set ([docs.x.ai/grok-bot/*](https://docs.x.ai/grok-bot/overview),
> 14 pages). Everything below is what the vendor documents; it is not an independent evaluation.

---

## 1. What it is

**Grok Bot** is xAI's ("SpaceXAI") always-on agent product: *"AI teammates you can give real work
to."* Launched in **early beta on Aug 11, 2026**. The unit of the product is a **Bot** — a single
persistent, *named* agent with a job title, its own conversation thread, and working context that
accumulates over time.

The defining architectural claim: **a Bot has a computer of its own.** Each user is assigned a
persistent cloud VM (managed Linux) with a **browser, filesystem, and terminal**. Bots do the work
inside the user's real tools rather than producing chat drafts — including tools with no clean API
or MCP server, driven by computer use.

Positioning against a chat assistant (from the docs' own FAQ):

| Assistant | Grok Bot |
|---|---|
| Answers questions | Completes work in the actual tool |
| Session-scoped context | Durable named identity, memory, files, browser sessions |
| Stops when you close the laptop | Runs 24/7 in the cloud |
| One agent, one thread | Multiple Bots in parallel, messaging each other |
| You orchestrate | Bots hand off ownership between themselves |

### The five stated differentiators
1. **Its own computer** — persistent cloud VM; connectors/MCP where available, computer use where not.
2. **Near-zero setup** — create a Bot, message it, grant access as needed. No workflow builder.
3. **Independent multi-Bot coordination** — Bots message each other, share threads/group chats, pass ownership.
4. **Learns workflows from live demonstration** — follow-along recording becomes a re-runnable routine.
5. **Durable named teammate** — memory, files, sessions, preferences persist; context compounds instead of resetting.

---

## 2. Platform, access, and commercial model

### Clients
- **Desktop:** macOS (Apple silicon **and** Intel), Windows (**x64 and Arm64**). Primary/full-feature surface.
- **Mobile:** iPhone, **iOS 18+** (App Store). Companion surface.
- **Not supported at launch:** Linux desktop, Android, iPad. (Note: the *agent's* computer runs Linux; the *client* does not ship for it.)
- Bots, conversations, routines, connectors and the shared computer **sync across all signed-in devices**.

### Identity & account layer
- Authentication is **Cursor account–based** ("Sign In with Cursor"), including existing **Cursor SSO** and team membership. Grok Bot inherits Cursor's team settings, privacy mode, MCP configuration, and team rules.
- **Legacy Privacy Mode blocks Grok Bot entirely** — the product requires cloud data storage. Accounts/teams must move to a supported data setting first.
- Admin controls live on the **Grok Bot page in the Cursor dashboard**.

### Eligibility & pricing (as listed on x.ai/bot)
| Plan | Price | Notes |
|---|---|---|
| **Cursor Ultra** | $200 / month | Bot's own computer, signs into tools, scheduled routines, desktop+mobile, extended token limits |
| **SuperGrok Heavy** | $300 / month | Highest usage at fastest speed, most powerful intelligence, dedicated support & early access |
| **Cursor Premium Teams** | $120 / seat / month | Everything in Ultra + central billing, team skill/plugin marketplace, shared usage analytics, SAML/OIDC SSO |
| **Enterprise** | Contact sales | Rolling out; waitlist |

- Availability tiers per the admin docs: **Individuals** (SuperGrok Heavy, Cursor Ultra, or a one-time trial); **self-serve teams** (Premium seats get a weekly Grok Bot usage allowance, Standard seats use trial or on-demand); **Enterprise** (rolling out).
- Subscriptions include **weekly usage**; eligible accounts can add **on-demand usage billed on model + token cost**.
- Invoices combine Cursor and Grok Bot charges, split per-product on the dashboard. **No Grok Bot–specific spend cap yet** — only account-level on-demand controls.

---

## 3. Core object model

```
User account
└── One persistent cloud computer (Linux VM)        ← shared by ALL that user's Bots
    ├── /workspace                                   ← shared durable file area
    ├── Browser profile (cookies, logged-in sessions) ← shared
    ├── Terminal + CLI credentials                    ← shared
    └── Per-Bot screens                               ← parallel work surfaces, NOT security boundaries

User account
├── Bots (≤ 50 Bots + group chats combined)
│   ├── Profile: name, title, description, avatar
│   ├── Own conversation thread + learned memory
│   ├── Enabled skills
│   └── Routines (≤ 50 per Bot, 20 most recent runs retained each)
├── Group chats (2–6 Bots)
├── Plugins / connectors (account-wide, MCP-backed)
└── Skills (available across Bots; some enabled per-Bot)
```

**Critical invariant, stated repeatedly in the docs:** the computer is scoped to the **user**, not the
Bot. "Do not use separate Bots as a security boundary." Any file or login placed on the computer is
reachable by every Bot on the account.

---

## 4. Bots — creation and lifecycle

### Creating
- Sidebar **New** (or `Cmd/Ctrl+N`) → **New chat** → **Create new agent** → opens a Bot named *New Agent*.
- **Bot actions → Edit Profile** sets name, title, description, avatar.
- Existing Bots can **suggest or create** a new focused Bot when a job deserves a long-lived owner.
- iOS: **+ → New Agent**.
- Onboarding flow ends at **"Meet a future teammate"** with suggested Bots based on which tools you say you use.

### Job design guidance
Create a separate Bot when work has a distinct **goal / toolset / working style / approval boundary /
recurring schedule**. Documented exemplar roles: *Talent Scout, Expense Manager, Bug Reproduction,
Sales Outbound, Paid Media, Product Performance, Account Health, Chief of Staff*. A vague
"General Helper" is explicitly called out as an anti-pattern.

**Description vs. message** is the durable/ephemeral split:
- Description → standing rules ("Never send external messages without approval.")
- Message → task instructions ("Draft follow-ups for these twelve accounts.")

### Management operations
| Action | Behavior |
|---|---|
| **Edit** | Change name/description; update description when a durable preference or boundary emerges |
| **Pin** | Keeps active Bots at the top of the sidebar |
| **Hide from sidebar** | Removes from main list without deleting work; does **not** pause the Bot or its routines. Restore via **Show hidden chats → Unhide** |
| **Duplicate** | Copies profile, settings, enabled skills, routines, avatar as `<name> copy`. Does **not** copy conversation history, learned memory, or attachments |
| **Delete** | Removes profile, conversation, and routines. Does **not** remove shared-computer files or browser sign-ins. No undo; hide instead if the work may be needed |

### Memory
A Bot retains stable preferences, important facts, role context, and summaries of prior work — so it
holds a role without replaying every message. The docs are explicit that **memory is not an
authoritative source**: keep changing facts in the source system, ask the Bot to cite or reopen
current data for consequential decisions, correct stale assumptions directly, and put hard safety
boundaries in the description rather than trusting memory.

---

## 5. The computer and app access

### Persistent cloud computer
- Managed **Linux VM**, one per member, Bot runs as a **non-root user**.
- Contains browser, filesystem (`/workspace`), terminal.
- **Work continues when the app, laptop, or phone is closed.**
- Each Bot gets **its own screen** on that shared machine → several Bots can drive browser/desktop tools in parallel. **One computer-use task per Bot screen at a time.**

### Watching and taking over
- **Agent Computer** view opens from a conversation: live clicks, typing, navigation, status.
- Leaving the preview does not stop work.
- **Human takeover** is the designed path for: passwords, passkeys, 2FA codes, CAPTCHAs, payment/identity checks, and sites that require a human. Flow: open Agent Computer → take control → complete only the blocked step → return control → tell the Bot to continue.
- The Bot should **pause and notify** rather than attempt to bypass a verification check.

### Secure secret request
For supported connections the Bot can present a **secure secret request**: the value is **masked,
excluded from the transcript, and never shown to the model**. It is explicitly *not* a general-purpose
password manager. Passwords and OTPs must never go into ordinary chat.

### Session persistence
Browser sessions persist, so sign-in is normally once — and because the browser is shared, a sign-in
performed for one Bot is available to **all** the account's Bots. Sessions can still drop when the
computer is recreated or its network address changes.

### Connectors / Plugins (MCP)
- Connectors appear as **Plugins**. Flow: **Settings → Plugins** → browse → **Add** → authenticate in browser → in chat type `@` to attach the connector to a task.
- **Installed connectors are account-wide**, not isolated per Bot; individual connector tools can be enabled/disabled.
- Doc guidance: **prefer a connector when one exists** (more reliable than clicking through a site); use the browser for services without a connector or for visual workflows.
- **Marketplace** for discovering connectors and packaged skills; **Yours** for installed plugins and private skills.

### Files
- Shared workspace at **`/workspace`**; project folders and descriptive names recommended for handoffs.
- Files, browser state, and supported sign-ins survive normal computer updates and recovery.
- **Treated as replaceable:** temp directories, manually installed packages, uncommitted app state.
- Final results should live in the conversation or be clearly linked from it, not only on disk.

### Computer maintenance
| Control (Settings → Beta) | Effect |
|---|---|
| **Update Agent Computer** | Rebuilds with the latest image, **preserves durable state** |
| **Recover Agent Computer** | Replaces an unreachable computer, preserves durable state when offered |
| **Reset Agent Computer** | Returns to the last durable snapshot; **can discard recent unsaved work** (last resort) |

App updates and Agent Computer updates are **separate**; updating the desktop app does not reset the VM.

### Local computer (separate capability)
The cloud computer is distinct from the Mac/Windows machine in front of you. Local execution is
governed by **Settings → General → Agent → Execution on Local Computer** with three states:
**Always require approval / Always allowed / Never allowed** (default: **Ask every time**). Docs
recommend **Never allowed** unless a Bot specifically needs local files. Bots can run commands, read
files, and move files between cloud and local computer; the first local action asks for consent and
every subsequent one passes through Auto Review with the exact command shown on the approval card.
A **team-level ceiling** (Never / Ask every time / Always, with members able to choose stricter but
not looser) is documented as *coming soon*.

---

## 6. Chat, collaboration, and multi-Bot coordination

### Messaging a Bot
Paste text/links/images, attach local files, reference a saved **skill with `/`**, mention a
**Bot / group / routine / connector with `@`**, reply to a specific message, react, and send new
instructions while work is in progress. The transcript interleaves normal messages with **tool
activity, computer use, created files, questions, and approval requests**.

- **Redirect in flight:** a direct message from you takes priority over background work and can redirect the current turn.
- **"Stop now"** ends work immediately — but does **not** undo actions already completed.

### Group chats
- **New → select 2–6 Bots**; auto-generated name is editable; membership editable later. iOS: **+ → New Group Chat**.
- Address the group generally (Bots decide who answers), `@` a specific Bot for ownership, or `@everyone` sparingly.
- Documented kickoff pattern: `@Researcher` gather + link every claim → `@Writer` draft → `@Reviewer` check against sources, blocking issues only → *do not publish*.
- **Limitation:** your messages can include attachments, but **Bot-to-group handoff messages are text-only** — a Bot must DM another Bot directly to pass an image.

### Bot-to-Bot handoff
A Bot can send an **asynchronous message** to another Bot; the receiver wakes, handles it, and replies
later, with the handoff visible in the conversation. Useful when one Bot owns a source system and
another owns the deliverable, when a specialist should review, when a blocker belongs to another role,
or to keep a long job moving without you routing it. Guidance: **one owner per stage** — too many
parallel handoffs create duplicate work and noise.

### Threads, reactions, search
- Thread replies for feedback on one result or approval request.
- Reactions for lightweight acknowledgement — explicitly **not** for safety-critical decisions.
- Search / command palette: switch Bots and groups, find prior messages, files, links, routines, open settings, jump back to the matching point in a conversation. (Cross-conversation search availability varies during rollout.)

---

## 7. Files, inputs, and deliverables

### Attachments
- Attach control or drag-and-drop; paste images and links.
- **Supported inputs:** images, audio, video; PDF and plain text; Word, Excel, PowerPoint; CSV, JSON, YAML, source code; HTML and email files; Jupyter notebooks.
- **Limits:** desktop composer accepts **up to 6 attachments at a time**; documents/images/audio **≤ 25 MB each**; video **≤ 200 MB**. Encrypted, damaged, or unusual files may be unreadable.

### Result design
Specify artifact + acceptance criteria: a document with headings and source links, a spreadsheet with
defined columns and formulas, a deck with speaker notes, a folder of screenshots and logs, an unsent
draft message, or a recommendation followed by evidence.

For consequential work, ask the Bot to separate:
1. Facts found in source systems
2. Assumptions / inferences
3. Actions already completed
4. Actions waiting for approval
5. Unresolved questions

### Previews and evidence
Files, images, links, and tool results render as **cards** in the conversation; open to preview, save,
open the source, or iterate. Revise the existing artifact rather than spawning disconnected copies.
Evidence practices: direct source links, screenshots showing relevant state, timestamps with time
zones, input/output filenames, a concise action log, and an explicit list of anything unverified.
Screenshots alone are insufficient for rapidly changing data — keep a link or export.

---

## 8. Skills, teaching, routines, and automation

### The two building blocks
- **Skill** = *how* to do a task (reusable instructions). Available across your Bots; a Bot still needs the relevant connector/login. Installed private skills can be **enabled per Bot** (Settings → Plugins → Yours).
- **Routine** = assigns a workflow to **one Bot** and says **when** to run it — on a schedule, or (where supported) after an event.

Recommended progression: **one-time task → make it reliable → save as a skill → only then automate.**

A well-formed skill states: (1) when to use it, (2) required inputs and access, (3) the sequence of
work, (4) how to validate the result, (5) what to return, (6) what requires approval.

### Teach a task (demonstration learning)
Where available: open a **1:1 Bot conversation + computer view → Teach a task →** describe the intended
result → perform the workflow once → stop recording → review the drafted skill → test on a safe example
before scheduling.
- Records **visible computer interaction only, up to 10 minutes**; **no microphone audio**.
- Avoid exposing secrets during the demo; use the secure handoff flow.
- Output is a **draft** — decision rules, failure handling, and approval boundaries must be added.
- Rolling out gradually; desktop only (not on iPhone). Fallback: have the Bot author a skill from written instructions plus the completed task.

### Routines
Created conversationally by asking the owning Bot, e.g. *"Every weekday at 8:00 AM, run the Daily
customer-risk skill against the current account list. Post a linked watch list in this conversation.
Do not contact customers. If the source data is unavailable, report the failure instead of using old
data."*

Confirm at creation: owning Bot, schedule + time zone, input source, expected result, approval
boundary, and missing-source behavior. Routines run while your laptop is closed.

**Event triggers:** Cursor account integrations can start a routine from an event (e.g. a Slack
message, a GitHub notification). These are **separate from the Slack/GitHub plugins** and may need
their own connection flow. Define narrow matching rules — broad "every new message" listeners create
noise, burn usage, and raise the odds of acting on irrelevant input.

**Test run:** performs **real work** — can navigate sites, change files, call connected tools. Review
whether it selected current inputs, met the output format, produced an audit trail for every action,
stopped at the intended approval point, and made failure states explicit.

**Management:** Bot → **View conversation details → Routines** — enable/pause, test, edit schedule or
instructions, inspect recent success/failure history, delete (immediate, no undo). Deleting a Bot
deletes its routines. **Limits: 50 routines per Bot; 20 most recent run records retained per routine.**
After a long absence Grok Bot may ask whether to keep routines running and **pause them if there is no
response**.

**Design-for-trust checklist:** automate preparation before execution; draft/reconcile/recommend first;
require approval for sending, purchasing, deleting, publishing, or production changes; include a
no-data and stale-data policy; make retries idempotent; define where partial completion is reported;
re-test after any website, connector, or schema change.

---

## 9. Approvals, security, and privacy

### Three layered controls
1. **Boundaries stated in the request / Bot description** — what it may change and where it must stop.
2. **Interactive approvals** — per-action review cards.
3. **Auto Review rules** — model-based pre-execution evaluation of tool calls and computer actions.

### Actions that warrant an explicit boundary
Sending messages or invitations · publishing content · purchases and financial transfers · deleting or
overwriting data · changing permissions · production changes · accepting legal terms.

> An approval controls the **proposed** action. **It does not reverse work already completed.**

### Approval UX
The conversation shows the proposed operation and its inputs; review target, scope, and values first.
- Desktop: **Allow once** / **Deny** / **Always allow** (can save a matching rule).
- iPhone: **Approve once** / **Deny**.
- Never approve an action whose target or effect you cannot identify — ask for a plain-language explanation or a draft first.

### Auto Review (Settings → General → Auto-review)
- **Require Approval** rules always stop matching actions.
- **Always Allow** rules let matching actions proceed **only if** the automated review finds no other reason to stop.
- **Require Approval wins** when both match.
- Write narrow rules tied to a known action + scope (e.g. *require approval before sending any external email*; *always allow `git status` in `/workspace/reports`*). Avoid broad rules like "allow everything in the browser."
- Auto Review is **model-based** — a complement to least privilege and explicit boundaries, not a replacement.
- **Personal rules are stored on the current desktop** and synced to its Grok Bot computer; verify separately on another desktop install.

### The shared-computer boundary (most important caveat)
All your Bots share one cloud computer. Files, browser sessions, and CLI credentials on it are
available to your whole Bot roster. Therefore:
- Do not use separate Bots as a security boundary.
- Sign out of services that should no longer be reachable.
- Remove sensitive temporary files after the work is done.
- Delete a connector **and revoke its authorization in the source service** when no longer needed.

### Access removal checklist
1. Pause or delete related routines → 2. Sign out of websites on the shared computer → 3. Uninstall
connectors and revoke authorization at the source → 4. Remove sensitive files from `/workspace` →
5. Hide or delete Bots → 6. Use the account settings flow to delete the Cursor account if required.
*Deleting a Bot does not remove shared-computer files or browser sessions.*

### Least-privilege setup
Connect only the tools a workflow needs · prefer scoped service accounts · start with read-only tasks
and drafts · keep sending/publishing/purchasing/deletion/production behind approval · review installed
connectors and active routines regularly · pause a routine when its source system changes · preserve
source links and an action log for important decisions.

### Data & privacy
Grok Bot uses **Cursor authentication and account data settings**. It **requires data storage** and does
**not support Legacy Privacy Mode**. Training opt-out follows the applicable Cursor account/privacy
settings. Contractual detail lives in Cursor's privacy policy and security documentation.

---

## 10. Settings, notifications, and app surfaces

### Settings map (`Cmd/Ctrl+,`)
| Section | Contents |
|---|---|
| **General → Account** | Cursor sign-in/out, About, installed version, iOS app link |
| **General → Appearance** | Follow System / Light / Dark |
| **General → Agent** | Default Model (when selection is available), **Timezone** (used by routine schedules), Execution on Local Computer, Auto-review rules |
| **Plugins** | **Marketplace** (connectors + packaged skills) and **Yours** (installed plugins, private skills); per-tool enable/disable; admin-required or -restricted team plugins |
| **Usage & Billing** | Weekly included usage and on-demand usage for eligible non-enterprise accounts; account menu may also show **Weekly usage** |
| **Team Setup** | Admin-provided managed setup that runs on assigned computers; members can review/reinstall. *Do not put secret values in managed setup instructions.* |
| **Beta** | Check for Updates / Restart to Update; Update Agent Computer; Reset Agent Computer; security-key and egress-routing options where available |

### Per-Bot settings
**View conversation details → Agent settings**: name, title, description, avatar, **Notifications**
preference. Note the asymmetry: these are per-Bot, while **Execution on Local Computer** and
**Auto-review** are shared across Bots on the current setup but are **not an account-synchronized
policy across devices**.

### Attention states & notifications
- Bot list distinguishes **Needs attention** (question / approval / handoff), **Unread activity** (new result), and working/typing status. Opening a conversation marks activity read; manual mark read/unread available.
- Per-Bot **Notifications** toggle fires an OS or mobile notification when that Bot finishes or needs input. **Group chats have no equivalent per-Bot switch.**
- Notifications are suppressed while the app is focused; sidebar and dock badges still show unread activity.
- Mobile push is **still rolling out**; in-app attention states remain the fallback.

### In-app errors
Surface above the composer under **Notifications**; dismissible individually or as a list. Some include
**Copy request ID** for support — share the complete ID. Clearing a notice removes the notification,
**not** the underlying external action or Bot history.

### iOS app specifics
Connects to the same Bots, conversations, routines, connectors, and shared computer.
- **Can:** send/dictate messages, take or attach photos, choose images/files, `@`-mention Bots and `@everyone`, reply in threads, react, save per-conversation drafts, create Bots and group chats, edit profiles, manage group members, pin/hide/delete, open the computer to watch work or take over for a password/2FA/CAPTCHA, search conversations and message/file/link/routine results, swipe actions, manage account/plugins/appearance/Auto Review/usage/iOS subscription.
- **Cannot:** edit a routine's schedule or instruction, view run history, test or delete a routine (view schedule/next run and Active pause/resume only), reset the computer, or use teach-by-demonstration. Those require desktop.

---

## 11. Teams and enterprise administration

### Model
Each member gets **one dedicated managed Linux VM**; all of that member's Bots share it, so files,
sessions, and permissions belong to the **member**, not to a Bot. Members sign in with Cursor accounts,
so existing **Cursor SSO and team membership apply**. Admin settings live on the **Grok Bot page in the
Cursor dashboard**; existing Team Settings (privacy mode, MCP configuration, team rules) apply to Bots.

### Rollout prerequisites
- Team must **not** be on **Privacy Mode (Legacy)** (blocks Grok Bot entirely).
- Plan for **static egress IP ranges** if services are IP-restricted (obtain current ranges from the account team).
- Decide how members sign in to company tools from the VM.
- Review inherited policy: MCP configuration, team rules, Auto-review instructions.

### Setup flow
1. Open **Grok Bot** in the Cursor dashboard → setup wizard (privacy mode, dedicated desktop, API pricing, pooled billing, model availability, premium seats). Re-runnable via **Admin setup**.
2. Review **Cloud Agents** — team-wide toggle for whether Bots can launch Cursor cloud agents (**on by default**).
3. Recommended: password-manager policy, installed via a **Team Setup script**; or ask members to enroll a **passkey** for company sign-ins.

### Isolation & security
- One managed Linux VM per member; Bot runs **non-root**.
- All of a member's Bots share the machine — secrets, sessions, and local-computer permissions are member-scoped.
- **Hosted MCP sign-in tokens stay in Cursor's backend**, which executes those tool calls on the computer's behalf; the VM never stores those tokens.
- The VM is **not enrolled in MDM by default** — device-trust agents like Okta FastPass are not natively available; enforce policy with install scripts instead.
- **Hardware security keys work:** WebAuthn prompts in the VM browser are forwarded to the member's desktop app and physical key. *Windows forwarding still in progress.*

### Computer administration
**Organization** admins (team-admin rights are insufficient, because a computer spans every team the
member belongs to) can inspect and remove member computers via **Grok Bot → computers**. **Kill**
deletes the running VM while **keeping durable storage**; the member's next session creates a fresh
computer. Members can reset their own computer from the desktop app (mobile cannot).

### Team rules
Dashboard team rules apply to Grok Bot and can be **scoped to Cursor, Grok Bot, or both**; scoped rules
are always in the Bot's context. Members personalize via **memories**, not personal rules. Guidance:
keep rules short and few (e.g. *"do not create personal access tokens"*, *"do not create new Slack
apps"*, *"never move company data to personal accounts"*) — for **enforcement**, use Auto-review
instructions instead.

### Plugin / MCP policy
No separate Grok Bot plugin controls — it follows the team's existing Cursor plugin and MCP policy, and
**MCP authentication is shared across Cursor + Grok Bot**. Controls under Team Settings → **MCP
Configuration**: disable all MCP globally; server allowlist/denylist; whether members may add their own
servers; **Require Team Network Allowlist** for fine-grained control. Blocked servers show
*"Disabled by team admin"* and refuse sign-in. Enabling a team plugin: enable it on the team plugins
page with any needed **plugin variables**, then add its server URL to the MCP allowlist (which applies
to all of the team's marketplaces).

### Models — no model picker
**Grok Bot has no model picker for members or admins, by design and by roadmap.** Each request routes
to a **fixed set of models per surface with automatic failover**; model choice is fully product-managed.
**Usage analytics show the model that actually served each request, including failovers, and billing
follows the actual serving model.** Contracts restricting subprocessors require an account-team
conversation before rollout.

### Governance gaps documented as not-yet-available
- **Audit view of Bot actions** — "coming"; today only spend and usage on the dashboard.
- **Grok Bot–specific spend cap** — not yet; account-level on-demand controls only.
- **Team-level local-execution ceiling** — "coming soon."

---

## 12. Documented use cases

Doctrine: *the best Bot roles own a repeatable outcome, not a loose category of questions.* Start with
read-and-prepare work, review, then add approved actions or a routine.

| Role | Owns | Typical connections | First task pattern |
|---|---|---|---|
| **Sales Outbound** | Account research, contact prioritization, review-ready outreach | CRM, intent sources, company sites, email, professional networks | Score ~25 accounts against ICP + intent, ≤3 contacts each, draft email + LinkedIn in attached voice, skip active sequences → **return a review list, send nothing** |
| **Talent Scout** | Sourcing, candidate research, outreach drafts, scheduling prep | ATS, approved sourcing tools, email, calendar | Find 20 candidates meeting must-haves, exclude existing ATS records, cite evidence per match, draft personalized outreach → **contact no one** |
| **Paid Media** | Campaign monitoring, budget recommendations | Ad platforms, analytics, budget sheet, Slack | Pull spend/performance by campaign vs. budget and target CAC, recommend reallocations with numbers, draft Slack update → **change no budgets, send nothing** |
| **Expense Manager** | Weekly reconciliation, missing-info follow-up | Expense system, email, shared drive, finance sheets | Build weekly summary against policy, match receipts from the finance inbox, flag exceptions **with policy citations**, draft one follow-up per owner → **send nothing** |
| **Product Performance** | Evidence-backed performance investigations | Observability, analytics, incident tooling, source control | Investigate a latency regression across dashboards/traces/flamegraphs, name the highest-confidence hotspot, screenshots + direct links, **facts separated from hypotheses** → **change no production settings** |
| **Bug Reproduction** | Turning reports into reliable repro packs | Issue tracker, staging, browser, network tools | Reproduce in staging on a fresh test account; return exact steps, expected vs. actual, screenshots, browser/OS, console/network notes, minimal test case → **no production customer data** |
| **Account Health** | Risk and expansion signals across a portfolio | CRM, product usage, support, billing, CS notes | Rank a watch list from usage + escalations + renewal timing + stakeholder activity, with evidence, why it matters, suggested next step → **no customer contact, no CRM edits** |
| **Chief of Staff** | Source-linked digest of what changed and what needs attention | Slack, email, calendar, meeting notes, planning docs | Since-yesterday review filtered to a priorities doc; per item: source, why it matters, proposed next step, whether a decision is owed → **send nothing, change no meetings** |

**Vendor's own internal usage (from the launch post):** a sales Bot updating CRM from call transcripts
and drafting follow-ups; an ops Bot seating new hires and processing Gmail invoices; an engineering Bot
reproducing a UI bug, filing the ticket, and handing the fix to a debugging Bot; demo-environment
readiness checks overnight; pipeline/CRM hygiene with a Monday scoreboard. The described org pattern is
**a chief-of-staff Bot sitting on top of lane specialists** (inbox, expenses, recruiting, bug fixes, ops).

### Promotion path for any role
1. Put job, source systems, output format, and standing boundaries in the **description**.
2. Run one real task at safe scope.
3. Correct until the result is reviewable.
4. Save the process as a **skill**.
5. Test on a second input.
6. Create a **routine** only once retries and failure cases are defined.
7. Keep consequential external actions behind **approval**.

---

## 13. Operational limits (consolidated)

| Limit | Value |
|---|---|
| Bots + group chats per account | **50 combined** |
| Bots per group chat | **2–6** |
| Routines per Bot | **50** |
| Run records retained per routine | **20 most recent** |
| Teach-a-task recording | **10 minutes**, visible screen only, no microphone audio |
| Desktop attachments per message | **6** |
| Document / image / audio attachment | **25 MB each** |
| Video attachment | **200 MB** |
| Concurrent computer-use tasks | **1 per Bot screen** (Bots run in parallel across their own screens) |
| Computers per user | **1** (shared by all that user's Bots) |
| Model selection | **None** — fixed per-surface model set with automatic failover |

---

## 14. Troubleshooting model

The documented principle is **least-destructive-first escalation**, and that a Bot's cloud work
continues even when the client is disconnected.

- **Sign-in fails** → keep the app open during browser auth; confirm Cursor sign-in succeeded; retry **Get started / Sign In with Cursor**; verify account access; complete org SSO rather than a personal account. A *Legacy Privacy Mode* error means the data mode forbids the required storage.
- **Computer still setting up** → initial setup and image updates take several minutes; keep the app open through *Starting/Updating your computer*; if stalled: retry → restart app → check for app update → **Update Agent Computer**.
- **Computer unreachable** → Retry/reopen → restart app → **Recover computer** → **Update Agent Computer** → wait → **Reset Agent Computer** *only* if you accept losing recent unsynced work. (Recover and Update preserve durable files and logins; Reset restores the last snapshot.)
- **Bot appears stuck** → check sidebar/conversation status; open the computer to see if it's waiting on a page; look for a question, approval, login, CAPTCHA, or secret request; send a short redirect or **"Stop now"**. An active computer-use task on that Bot's screen may need to finish before another starts. Also check for exhausted usage or an on-demand spending limit.
- **Site keeps asking for login** → take over, sign in, complete 2FA/CAPTCHA, confirm the signed-in page loaded, return control. Never paste credentials into chat.
- **Plugin won't install/authenticate** → confirm installed under Settings → Plugins → re-run the auth action with the intended account → retry → check for a required org-provided variable or admin configuration. If revoked at the source, remove and reconnect.
- **Attachment unreadable** → check size (25 MB / 200 MB video), ≤6 attachments, not encrypted/password-protected, upload finished, supported type. Export odd formats to PDF/CSV/text/image — but do not strip document protection if that would violate data policy.
- **Routine didn't run** → verify enabled, schedule + time zone, owning Bot still exists, plugins still authenticated, computer can reach the source, usage/account not paused; inspect run history; for event triggers re-verify channel/repo/matching rule. Use **Test run** only with safe input.
- **Approval blocked** → read target and arguments; reject/cancel if stale, send a replacement instruction, or ask for regeneration with corrected scope. Repeated approvals usually mean a matching **Require Approval** Auto-review rule (Require beats Allow).
- **Local work refused** → cloud and local permissions are separate; check **Settings → General → Agent → Execution on Local Computer**.
- **Websites blocking the Bot** → some services flag datacenter IPs; allowlist the egress ranges, or use the beta setting that routes computer traffic through the member's own machine.
- **Before contacting support**, collect: Grok Bot version, OS + version, exact error, Bot/routine name, approximate time + time zone, full request or conversation ID, and whether retry/restart/Update Agent Computer changed anything. **Never include passwords, one-time codes, private keys, or secrets.**

---

## 15. Design lessons worth stealing

Distilled from the above — the patterns that make this system's design coherent, useful as reference
for building anything similar:

1. **Persistent environment over persistent context.** Durability comes from a VM with a real filesystem, browser profile, and terminal — not from a longer prompt. Memory is explicitly demoted to "working preferences," with the source system remaining authoritative.
2. **Computer use as the universal fallback.** Connectors/MCP are preferred where they exist; computer use covers the long tail of tools with no clean API. The two are complementary, not competing.
3. **Named roles beat generic agents.** A stable name + job + description gives memory something to accumulate against and makes approval boundaries reusable. "General Helper" is called out as an anti-pattern.
4. **Honest security boundary.** Rather than implying per-agent isolation, the docs repeatedly state that the computer is user-scoped and that Bots are **not** a security boundary. Per-Bot screens are described as work surfaces, not sandboxes.
5. **Humans in the loop exactly where automation is unsafe.** Passwords, 2FA, CAPTCHAs, payment and identity checks route through an explicit takeover; secrets that must be typed go through a masked channel excluded from the transcript and hidden from the model.
6. **Approvals gate proposals, not outcomes.** Stated plainly: approval does not reverse completed work — which drives the whole "draft first, act second" doctrine.
7. **Graduated automation.** one-time task → reliable → skill → tested → routine. Automate *preparation* before *execution*; keep sending/purchasing/deleting/publishing/production behind approval permanently.
8. **Layered enforcement.** Request-level boundaries (soft) + Bot description (durable) + interactive approvals (per action) + model-based Auto Review with **Require beating Allow** (policy) + team rules and MCP allowlists (organizational).
9. **Peer-to-peer agent messaging with single-owner discipline.** Async Bot-to-Bot handoffs remove the human as router, but the docs insist on one owner per stage to avoid duplicate work.
10. **Evidence as a first-class deliverable.** Source links, screenshots with visible state, timestamps with time zones, action logs, and an explicit "could not verify" list — plus the five-way split of facts / assumptions / actions taken / actions pending / open questions.
11. **Deliberate removal of model choice.** No picker at any tier; fixed per-surface routing with failover, but with transparency (analytics show the actually-serving model) and honest billing (charged on the serving model).
12. **Least-destructive-first recovery, with the destructive option named as such.** Update → Recover → Reset, with data-loss consequences stated on each rung.

---

## 16. Known gaps and rollout caveats (as of Aug 2026)

- Early **beta**; several features gated by gradual rollout: **Teach a task**, cross-conversation search, mobile push delivery, Auto Review enforcement, Usage & Billing surface.
- **No Linux desktop client**, no Android, no iPad.
- **No audit view of Bot actions** for teams yet; **no Grok Bot spend cap**; **no team-level local-execution ceiling** yet.
- Bot-to-group handoff messages are **text-only**.
- iOS cannot edit/test/delete routines, view run history, reset the computer, or teach by demonstration.
- Windows forwarding of hardware security keys still in progress.
- Some websites block datacenter IPs; sessions inside the VM can drop when it is recreated or its address changes.
- Enterprise access is waitlisted / rolling out.

---

## Sources

- [Grok Bot product page — x.ai/bot](https://x.ai/bot)
- [Introducing Grok Bot (launch post, Aug 11 2026)](https://x.ai/news/introducing-grok-bot)
- [Docs — Overview](https://docs.x.ai/grok-bot/overview) ·
  [Get started](https://docs.x.ai/grok-bot/get-started) ·
  [Use cases](https://docs.x.ai/grok-bot/use-cases) ·
  [Bots](https://docs.x.ai/grok-bot/bots) ·
  [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) ·
  [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) ·
  [Files and results](https://docs.x.ai/grok-bot/files-and-results) ·
  [Skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations) ·
  [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy) ·
  [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications) ·
  [Mobile (iOS)](https://docs.x.ai/grok-bot/mobile) ·
  [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises) ·
  [Troubleshooting](https://docs.x.ai/grok-bot/troubleshooting) ·
  [FAQ](https://docs.x.ai/grok-bot/faq)
