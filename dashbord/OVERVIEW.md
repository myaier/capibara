Agent Observatory is a dashboard for every Paseo agent and subagent on a host. Each session opens on its result, timeline, subtasks, diagnostics and a deterministic execution recap. It adds a sidebar count of what needs you with a reason per agent, approvals and quick replies in place, an unread queue, usage statistics, token counts from local Claude Code, Codex, Grok CLI and Pi logs and every scheduled run.

It adds the sidebar pages Agent Observatory, Archived sessions and Scheduled runs, workspace and agent panels, Command Center items and `/observe`. On connect the app receives only a small stub and the badge; the rest loads when first opened.

## Setup

Requires Paseo 0.11.1 or later.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Agent Observatory → Language picks one; English stands in for a missing translation. A translated copy of the bundled template in `~/.paseo/plugin-data/agent-observatory/locales/` adds a language.

## What it reads

- From the daemon: agent events, attention notifications, the agent list (archived included), pending permission requests of an agent you open, profiles and providers, usage windows (`providers.listUsage()`, only while a page shows them), and timelines of what you open. In the background it reads only loaded agents.
- Result images: when a reply is displayed, local image references in that agent's displayed reply can read PNG, JPEG, GIF, WebP or AVIF files on its daemon host, up to 8 MiB each. Relative paths use the agent's working directory; `file://` paths also support temporary attachments. Image bytes travel in bounded RPC parts and are not saved by the plugin. The exact reply and its allowed image references are retained in a bounded in-memory cache for five minutes while images load; newer output does not invalidate that displayed reply. Missing or unsupported images show a reason and retry option.
- Token logs: `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), `~/.config/claude/projects`, `$CODEX_HOME/sessions` and `archived_sessions` (default `~/.codex`), each Grok CLI session's `usage.json` (never the conversation files) and Pi's sessions (default `~/.pi/agent/sessions`), without following symlinks. Only counters, model names, working directories and session ids are kept, never prompts or output.
- For custom providers based on these: a literal `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR` in the provider's `env`, command line or launcher script (read as text, at most 64 KB, never run; no other values), and Pi's `sessionDir` setting.
- To confirm a resume, the agent's own Claude Code, Codex or Pi session log is searched for that run's ids (compared, not kept).
- Scheduled runs: `$PASEO_HOME/schedules/*.json`, `projects/workspaces.json`, and the records of agents the daemon no longer lists. It never writes them.
- The daemon config's provider list, to tell which providers take a message mid-turn and which share a usage limit.

The client loads HTTP(S) images embedded in displayed Markdown directly from their URLs. The daemon does not fetch remote images.

## What it writes

Plugin records go to `$PASEO_HOME/plugin-data/agent-observatory` (folder 0700; files 0600, bounded, replaced atomically): telemetry, statistics, token counts, usage-limit history, read receipts, preferences, the schedule and resume ledgers, the device's time zone name, the send ledger (messages on their way, then a week of short previews), the language state and translation templates. Session names and their manual/generated provenance labels are saved by Paseo through its agent update API.

The schedule ledger keeps run times, status, ids, the host's error messages (300 characters), links without credentials, schedule names and cadences, never replies or prompts. Usage-limit history keys accounts by a hashed name. Telemetry keeps why a turn stopped and a merge or pull request link, never the reply.

## Actions

The following actions run when you ask; automatic session naming is described separately below:

- marking a result, question or error read; archiving agents (bulk archiving needs a second tap and skips heartbeat targets); restoring a workspace or an archived session;
- answering one tool permission request with the provider's own options, exactly as chosen, never in bulk or automatically;
- sending a quick reply (the button's words) to an agent: steered into the running turn where supported, otherwise after you confirm the interruption, or queued until the turn ends; a retry is delivered at most once;
- scheduling a one-off heartbeat, at a time you confirm, that resumes an agent after its usage limit resets; it counts as done only on proof tied to that run, is never resent when the host cannot tell, and only the plugin's own resume heartbeats are deleted;
- handing a stopped agent over to another profile;
- renaming a session from its context menu; manual names are preserved by automatic naming.

Some use daemon messages the plugin API lacks, over its own daemon connection. It can open http(s) links.

## Session names

Opening the session list queues background naming for unarchived sessions whose title still matches the first-message placeholder. Existing custom names and manual renames are preserved. A bounded excerpt of the first user message (at most 2,000 characters, with common credential formats masked) goes to a listed lightweight model on an enabled provider, preferring the session's provider and the lowest supported reasoning setting. At most two candidates are tried, with a 20-second generation deadline each; failure leaves the original title.

Naming uses a temporary Paseo session in a restricted mode, with no preapproved tools. It is archived afterwards; the provider's normal usage and session-log retention apply. This updates the Paseo title, not the coding provider's independently stored thread name.

## Limits

- Imports and scans are capped (for example 20,000 token logs); the pages say when a cap applied.

The scheduled runs page is modeled on the schedule-runs plugin by panrafal.

## Multiple machines

The original global screens combine every connected installation through Paseo authenticated connections. There is no machine picker. Business filters retain source identity; operations target the source machine. Full statistics require a compatible backend on each machine. Historical concurrency is an observed lower bound, and filtered history is limited to retained session/hour attribution. Unavailable machines and unverified deduplication coverage are explicit.
