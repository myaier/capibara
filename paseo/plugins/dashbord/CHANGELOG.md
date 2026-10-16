# Changelog

## 2.20.0-dev.1 · Capibara · 2026-10-16

- The version chip at the top right becomes **Hosts**. Its panel lists every host Paseo is connected to with this plugin's state there: up to date, update available, updating, failed, offline, or no observatory running. The chip shows the version while every host is fine and what needs you otherwise; phones show it only then, and the ⋯ menu always offers **Hosts**.
- **Update all** brings every installed host to the revision this page's installation offers, through each host's own reviewed update: other hosts first, this page's last. A host whose source offers a different revision is left alone and says so. **Not now** postpones the prompt as before.
- **Install** (or **Sync all**, which also updates) puts the observatory on a connected host where none runs. After you confirm the commands shown, it opens a terminal in one of that host's workspaces and runs `paseo plugin add` with this installation's own source; where the plugin is already configured there, it enables and updates it in place instead, keeping that host's source. Windows hosts run it through cmd.exe, others through /bin/sh. A failure keeps the terminal open and shows its last lines and the commands to run by hand.
- The device never reads a host's daemon config. A host can be ignored so it no longer prompts.

## 2.19.0-dev.8 · Capibara · 2026-10-16

- Fix tapping Agent Observatory, Archived sessions or Scheduled runs on phones appearing to do nothing. Use Paseo's sidebar navigation callback so the mobile drawer closes and reveals the destination.
- Opening a session or the observatory from the attention badge now closes both the popover and mobile drawer. Keep machine-specific screen IDs and the selected session's source machine.

## 2.19.0-dev.7 · Capibara · 2026-10-16

- The update dialog is a narrow card (at most 440 px) instead of the host's wide modal, and closes with Escape.
- Updating shows an estimated progress bar: fetching and building approach 85% over about a minute, the plugin restart is at least 90%, and the new revision answering is 100%. The toolbar chip shows the percentage while the dialog is hidden; **Continue in background** keeps following it.
- If the panel reloads during the restart, the restarted plugin reports the update it finished (from → to) once.

## 2.19.0-dev.6 · Capibara · 2026-10-16

- Every session row now leads its second line with a small mark of its harness (Claude Code, Codex, Kimi, OpenCode …), running or not, archived ones included. The live speed chip is separate again: 「⚡ 34.1 tk/s」.

## 2.19.0-dev.5 · Capibara · 2026-10-16

- Encode machine-specific screen IDs using the characters Paseo accepts, restoring the shared sidebar after installation. Validate the generated IDs against the SDK schema.

## 2.19.0-dev.4 · Capibara · 2026-10-15

- Give every installation stable internal screen IDs while retaining one shared sidebar entry. Reconnecting another machine no longer unregisters the open page; each real screen still has no machine picker.
- Preserve legacy links through redirects and retain entity ownership when opening another view. The shared entry chooses an available installation when its previous host is offline.


## 2.19.0-dev.3 · Capibara · 2026-10-15

- Keep the fleet view alive when a remote detail loses its connection. Resolve source SDK handles only when operations run, isolate subscription cleanup failures, and rebind after connection replacement.


## 2.19.0-dev.2 · Capibara · 2026-10-15

- Fetch each host session directory through its authenticated plugin data channel when available, avoiding timeouts in the borrowed client directory transport. Keep native subscriptions for live updates and native listing for older installations.


## 2.19.0-dev.1 · Capibara · 2026-10-15

- Merge all connected machines directly in the original panels; remove the host picker by registering one shared entry.
- Preserve source identity in sessions, events, schedules, details and operations. Add project, provider and model filters to statistics and Token views.
- Read complete rankings in immutable RPC parts, recompute dates and weighted statistics, reconcile proven copied Token calls and shared account quotas.
- Show missing-machine coverage and historical metric limits. Preserve the latest main changes to session names, timeline ordering, image loading and removal of intelligent reviews.

## 2.18.0-dev.10 · Capibara · 2026-10-15

- The update sheet no longer says the release notes are unreadable when a new revision simply adds no release (documentation or other plugins in the repository); it says so plainly, and the update stays available.

## 2.18.0-dev.9 · Capibara · 2026-10-15

- Show the observatory version at the top right of the panel. When the plugin source has a newer revision, it turns into an update prompt; phones show it only then, and the overflow menu always has **Version and updates**.
- The update sheet lists the release notes between the installed and the new version. **Update now** applies exactly the reviewed revision through Paseo's own reviewed update, then the panel reloads; **Not now** hides the prompt until a newer revision appears.
- Paseo has no automatic plugin updates. The host checks its own source at most every 30 minutes while a panel is open, reads the notes from a private shallow copy, and updates only this host.
- Publish `CHANGELOG.md` with the installable snapshot so later updates can show their notes.

## 2.18.0-dev.8 · Capibara · 2026-10-15

- The session list opens on every non-archived session, grouped by state: 需要处理 → 执行中 → 待回复 → 已完成 → 空闲 → 已关闭. A thread lands in 需要处理 or 执行中 when anything in it needs you or runs; otherwise it follows its top-level session. The state chips (需要处理 / 执行中 / 未读 / 待回复 and the 状态 filter) are no longer restored on a fresh open; returning from the archive page still keeps them.
- Running 执行中 rows keep their places while they stream: grouped order uses the turn's start, not the latest activity. Rows that still move glide to their new place and new rows fade in, instead of jumping; reduced motion and filter switches move at once.
- A running row's speed now reads 「57.1 tk/s」 behind a small mark of its harness (Claude Code, Codex, Kimi, OpenCode, Copilot, Gemini, Grok, Pi …). Custom providers show the provider they extend.

## 2.18.0-dev.7 · Capibara · 2026-10-15

- Temporarily remove intelligent trajectory analysis, automatic reviews, cross-session suggestions, their settings, RPCs, queues, report storage and Grok runner.
- Keep deterministic recaps, timeline diagnostics, quick replies and session naming; extract their shared redaction, send-capability and metadata-generation helpers.
- Bind local image loading to the displayed reply so newer output cannot invalidate in-flight image parts; explain missing files and allow retry after restoration.
- Preserve historical review records on disk and continue excluding legacy helper sessions from ordinary work lists.

## 2.18.0-dev.6 · Capibara · 2026-10-15

- Automatic naming now recognizes Codex sessions started with a slash command or skill. Paseo titles them from the `/name …` input, while Codex records the first message as `$name …`; such titles were previously mistaken for custom names and skipped.

## 2.18.0-dev.5 · Capibara · 2026-10-15

- Show execution timelines newest first, after merging message fragments and tool results in source order. Load older history from the bottom.
- Animate live arrivals by expanding their height and fading them in, smoothly pushing existing rows down. Initial history, older pages, filter changes and tool updates do not replay entrances; reduced motion shows records immediately.
- Verify actual row movement, history loading, search jumps and retained expansion on desktop and mobile web layouts.

## 2.18.0-dev.4 · Capibara · 2026-10-15

- Add session context menus on right-click, long-press and the overflow button, with rename and confirmed archive actions.
- Generate concise provisional titles in the background using listed lightweight models at their lowest supported reasoning setting; preserve manual names and verify saved results.
- Keep the original panels and the Markdown reply and local image support from dev.3.
- Verify the installed Paseo build and the complete rename/archive flow on a disposable session.

## 2.18.0-dev.3 · Capibara · 2026-10-15

- Latest replies render Markdown images, tables, task lists, emphasis and fenced code. Wide tables scroll horizontally on phones, and copying a reply preserves its original Markdown.
- Local images, including `file://` temporary attachments, load from the session's daemon in bounded RPC parts. Reads are limited to image references in that agent's latest reply and supported image formats up to 8 MiB. Missing images show a retry action.
- Based on the deployed original-panel development build (`586d05c`), preserving its authenticated host RPC support. Cross-host panel rollout remains in development; this release does not mark its outstanding acceptance gates complete.

## 2.17.0 · Capibara · 2026-10-15

- Added an all-host session and archive overview using the app's authenticated host connections. Host, project, status, and time filters retain session ownership, including duplicate IDs on different machines.
- Opening a row targets its original host and session. Offline caches, failed reads, and truncated directories are explicit; reconnects, connection replacement, live updates, and background suspension are handled independently per host.
- Kept the existing host workbench and workspace panels for detailed results and host-local statistics and actions.
- Restored reproducible lazy UI builds and reject stale generated code before packaging a release.
- Fixed concurrent language-state saves overwriting newer settings or writing after disposal.

## 2.16.0 · 2026-10-15

Added English, Simplified Chinese, and user language files, with Follow system as the default. Language can be changed in Observation settings or Paseo plugin settings. Interface text, accessibility labels, feedback, and server messages use shared catalogs. New analyses request the selected language; stored reports keep their original text.

## 2.15.2 — 2026-10-14

Privacy fixes for what the observatory writes, sends and shows. Saved data carries over; what older versions kept that is no longer kept is cleaned when it is read.

**AI reviews**
- Grok CLI also records each review's prompt, with the session excerpt, in its own session-search index (`~/.grok/sessions/session_search.sqlite`), and the record stayed after the session was deleted, searchable from your other Grok sessions. Reviews now run with session search off (`GROK_SESSION_SEARCH=0`), and the run's record is deleted afterwards: freed pages are overwritten, the full-text index is merged and the write-ahead log emptied, with a second look a minute later. The startup sweep, and a second sweep an hour after start, remove records of interrupted reviews too. Only a record's directory, id and time are read, never its content. Two limits: while another program is reading the database the write-ahead log cannot be emptied, and the deleted text can stay in the log file until later writes overwrite it (search no longer finds it); leftovers are recognised by name, so any directory in the temp folder whose name starts with `paseo-insight-` counts as the observatory's, including one you named that way and the Grok sessions run in it.
- The Grok CLI gets only the environment it needs (`PATH` with absolute entries only, `HOME`, user, locale, time zone, temp directory, proxy and certificate settings, `GROK_*` and `XAI_*`), not other providers' keys from the daemon's environment. A relative `PATH` entry is no longer searched for `grok`.
- Masking covers more formats: npm, temporary AWS keys, Slack app and refresh tokens, Google OAuth tokens and client secrets, more GitLab tokens, Hugging Face, SendGrid, Stripe (`rk_`, `whsec_`), Groq, Composio (`ak_`), passwords in URLs of any scheme, Slack and Discord webhooks, and `key` / `sig` / `signature` URL parameters. Values in JSON that was stringified twice, and prefixes right after a `\n` escape, are recognised.
- Text is masked before it is cut or turned into JSON: a cut could drop a private key's header or a token's prefix and send the rest as it was. In structured tool input and output, every string under a field whose name says it is a credential (`password`, `AWS_SESSION_TOKEN`, `api_key`, `Authorization`, `credentials`…) is masked whole, whatever it looks like, and the JSON is masked once more before it is cut (a cut could drop the field name and keep the whole value). Session details and the previous review are masked before they are cut too. The report and suggestions a model writes are masked again before they are stored (a provider reviewer can quote files it read on its own).
- Analysis settings and the first review say that the session excerpt goes to the chosen model's provider and that masking is not exhaustive.

**Scheduled runs**
- For a failed turn the host records the Agent's last reply as the run's error, and the ledger kept its first 300 characters after the schedule was deleted. The ledger now keeps only the host's own error messages, or the `[System Error]` part the host adds after the reply (masked); anything else becomes a note that the error text was the Agent's reply and was not saved. Older ledgers are cleaned when read.
- Merge and pull request links lose any `user:password@` (a push URL can carry a token), including links already stored in the ledger and the event history.
- A damaged ledger, usage-limit history or suggestions file keeps a single backup, replaced the next time, instead of a new copy each time; log lines name the error instead of quoting the file.

**Other**
- 交给另一个 Provider and 交给 Agent get the profile list from the plugin server: id, name, provider, model, mode, thinking option, feature values and notes only. The device no longer receives the whole daemon config (provider environments, commands, plugin sources). Like the host, the list sets no length limits: the name and notes, which are only shown, are shortened when long (400 / 4,000 characters), the fields passed on to the new Agent are given as they are, and no profile is left out for a long value.
- Send ledger: at most 3 copies of an unreadable ledger, for a week; temp files of interrupted writes are removed at the next start; log lines name the error only. The shared lock folder is tightened to 0700 and lock files are created 0600.

## 2.15.1 — 2026-10-14

- The server splits the lazily loaded interface chunk on its first request instead of at startup, and slices the source text instead of building strings character by character. This cuts startup CPU and resident memory; the RPC part budget and the interface stay the same.

## 2.15.0 — 2026-10-13

Lighter loading on phones and a fix for the Android app. Saved data carries over unchanged.

- On connect the app receives only a small registration stub (`index.client.tsx`, compiled by Paseo, at most 32 KiB) and the sidebar needs-attention badge. The pages, panels and the badge popover, with its in-place approvals and quick replies, are fetched from the daemon in parts the first time one opens (each reply under 128 KiB), cached by content hash for the app session and evaluated afresh on every connection. A load shows a placeholder and can be retried; a version mismatch asks you to reconnect.
- The badge stays resident: it refreshes every 20 seconds in the foreground, hides failed or stale counts and reports the device's time zone. The badge, the failed-run count, the popover and the dashboard share one needs-attention reading, so 知道了, 标记已读, an approval or a quick reply updates the badge at once.
- Android: the sidebar status module failed to load under Hermes's default evaluator; it now uses a closure-based store. Client code no longer uses `class`, and a repository-wide check guards the Hermes build, the entry export and Paseo's interop patch.

## 2.14.0 — 2026-10-12

Fixes from a second review and a batch of features for handling things from your phone. Saved settings, receipts, snoozes, reports, statistics, token records and the schedule ledger carry over; new fields are optional. Downgrading to 2.13: token statistics can be re-imported only from the session logs that still exist (Claude Code keeps 30 days by default) and the old file is kept as `tokens.json.corrupt`; the 明细 → 观测 history is reset.

**Needs attention**
- One rule for the list, the sidebar badge, the popover and the detail: a turn that hit a usage limit, produced nothing or stopped half-way counts until you look at it, sub-agents included, and 稍后处理 (snooze) does not apply to it. Its button is 知道了 (got it), which clears the alert without a completion receipt. A turn still running when the host closed the session shows as 可能未收尾 and counts until you press 知道了 (kept across restarts).
- 标记已读 (mark read) records the latest turn's completion time, verified by the server against the end time the plugin observed, so a result stays read after archiving, restarting or restoring, also when heartbeats run several turns in a row; a result can be marked read only while the page shows that very turn. Snoozes and quick replies follow turns the same way.
- For agents the host has not loaded (all of them after a daemon restart), 标记已读 and 知道了 check the host's alert token and keep the receipt in the plugin instead of loading the agent; Paseo clears its own alert the next time the agent loads.
- Screen-reader labels match each row's state, the popover fits the host's 440 px desktop limit, and storage warnings are full sentences.

**In-place approvals and quick replies**
- A pending tool approval can be answered from the popover (在这里审批) and the result page. It shows the full command or arguments (up to 64 KB per item, with a note when cut), files and working directory, and offers the provider's own options, answered exactly as chosen (lasting ones take a second tap), or 批准 / 拒绝 / 拒绝并中断. Never in bulk and never automatically; questions and plans stay in the chat.
- Quick replies: when the latest reply asks whether to go on, or announces a next step and stops, the detail offers 继续，按你说的做 or 继续做完, and 先别动. The button's words are what is sent. A quick reply answers only its own turn: one per turn from any device, none once another turn has begun or when the plugin cannot verify the turn. Sentence patterns only; no model call, no stored reply text.
- Quick replies and 发给这个 Agent (send to this agent) go through a send ledger on the plugin's server (`deferred-send.json`, the same code as Project Notes), which plans again from the agent's state under a per-agent lock: it steers into the running turn where the provider supports it, otherwise asks you to confirm the interruption for that turn or offers 等这一轮结束再发 (send when this turn ends), which queues the message until the turn ends and no approval is pending, even with the app closed. One message id per message, so a retry after a lost reply never sends twice.

**Why a turn stopped**
- Replies that only describe rate-limit or quota handling are no longer read as a usage limit; every Claude Code 2.1 limit notice is recognized; a reset time without a zone (resets 5am) is read in the device's time zone and marked as a guess; daylight-saving days are handled.

**Resume after the limit resets**
- The one-off resume heartbeat is written at a UTC time on a minute no other schedule uses and checked against the host's wake time. It counts as done only on proof tied to that run: the host's run record, or the resume prompt with the run's ids in the agent's own Claude Code, Codex or Pi session log (Grok sessions are never opened). When that cannot be told, the card says 未能确认续跑 (could not confirm) and nothing is resent automatically. A busy agent or a missed minute is retried for up to 6 hours; messaging the agent yourself cancels the resume; the stop card shows the real state and can cancel or reschedule.
- The plugin deletes only its own one-off resume heartbeats, once a resume is done or canceled, and follows one whose time you moved in Paseo; one you changed otherwise is left to you.
- New choices: 按额度窗口 (by usage window) when the reply gives no reset time, and 交给另一个 Provider… (hand over to another provider): a new agent in the same workspace whose editable first message points it at the original session.
- Known limits of Paseo 0.11.1, which has no idempotent create and no conditional delete: a heartbeat the host writes more than two minutes late can still wake the agent after it was marked unconfirmed, and a heartbeat you edit in Paseo after the plugin last read it can still be deleted.

**Time zones, usage limits and tokens**
- The Token page, 今日 Token, the live rate, 明细 → 观测 and the analysis overview split days in the device's time zone, daylight-saving days included; hourly data is kept for 29 days.
- Usage-limit capsules warn only on current readings (an old one shows 读数 08:30), and usage is sampled only while a page shows it.
- New token sources: Grok CLI (each session's `usage.json` only) and Pi, also behind custom providers. Custom providers' log directories are taken from their env, command line and launcher script in the order their process gets them (read as text, never run). Long sessions with many sub-agents no longer re-read every log on each poll.

**AI reviews (Grok CLI)**
- The session Grok CLI saves for an analysis, which holds the whole prompt, is deleted when the analysis ends; leftovers of an interrupted run are removed at the next start (only the plugin's own `paseo-insight-*` groups). Built-in tools are removed with `--disallowed-tools` and cross-session memory is off.

**Sessions, schedules and archiving**
- Restoring a session runs as a server task with step-by-step progress; the timeline has find-in-page; 归档已读完成 (archive read results) leaves agents a heartbeat or an unfinished sub-agent still needs, and is unavailable while the schedules cannot all be read. The plugin's `agent.turn_ended` handlers are one host registration.

## 2.13.0 — 2026-10-11

Fixes from the review of 2.12 and features that show at a glance who is waiting for you and why. Saved data carries over; 2.12 ignores the new fields.

- A needs-attention count beside Agent 观测台 in the sidebar, with a popover of up to 8 agents, oldest first, each with a one-line reason; the count is computed on the server with the page's rules and hidden whenever it cannot be trusted. The scheduled runs page shows failures of the last 24 hours.
- One-line reasons without a model call: a question, a plan, a command awaiting approval, an error, a usage limit and its reset. Host alert text is kept in memory only (at most 160 characters, credentials masked).
- Questions and plans no longer show as approvals. Turns that hit a usage limit, produced nothing or stopped after a tool call are labelled instead of 已完成 or 空闲, from the failure reason and the closing sentences only; nothing is stored. A one-off heartbeat you confirm can resume the agent after the limit resets.
- Rows show todo progress, context use, links to merge and pull requests (only the link is stored) and heartbeat wake times; 归档已读完成 takes a second tap; 发给这个 Agent steers into the running turn where supported instead of interrupting it.
- Statistics no longer drop late-evening turns in time zones west of UTC. The Token page adds usage per Paseo provider and the host's usage-limit windows (`providers.listUsage()`; account names stored only as hashes), and reads Codex's archived sessions.
- Scheduled runs are recorded in the background (the schedules folder is watched), and cadences read as Chinese sentences.
- Performance: one shared agent directory per host, rows updated in place, incremental timeline reads (a five-minute session went from 108 to 57 requests and from about 74 MB to 4 MB).
- Uses Paseo 0.11's screen and sidebar APIs, with fallbacks for older hosts.

## 2.12.0 — 2026-10-10

Security hardening after two external reviews of the published plugin. Saved settings, reports and statistics carry over unchanged; a saved built-in Grok choice keeps running grok-4.7 · xhigh.

- 智能分析 only starts a Paseo analysis agent in an explicitly chosen mode whose restriction is known: a read-only mode (Codex and providers that extend it in Codex's read-only sandbox, Cursor's Ask, plan modes) or Claude Code's Always Ask. A provider that lists no modes used to start one with no mode, which made the daemon copy the analysed Agent's mode (often unattended); it is now unavailable. Modes that may act without asking (an ACP agent's Default or Agent mode, OpenCode's Build) are no longer used: such providers analyse in their plan mode, or are unavailable without one. The runner also refuses to create an agent without a verified mode. Codex's sandbox options are sent only to Codex and providers that extend it, not to any provider whose mode ids happen to match.
- Profile feature switches are an allowlist (speed and reasoning effort); auto-accept, plan, agent and other access switches no longer reach an analysis agent, and ACP and OpenCode analyses switch auto-accept off explicitly (their daemon clients turn it on for children of unattended Agents otherwise).
- The ask-first caution now says what happens: approval requests are denied, but actions the provider allows without approval (reading files) can still run. The badge reads 需审批时拒绝 instead of 工具会被拒绝.
- 分析设置 has Grok 模型 and 推理档 (xhigh / high / medium / low) for the built-in Grok CLI. Unset values are grok-4.7 and xhigh, so a saved `{ kind: "grok" }` is read and written as before; a model id must start with a letter or digit and use only letters, digits and `._:/-`, so it can never become a CLI option.
- Credential masking before a trajectory leaves the host also covers PEM private keys (including JSON-escaped and cut-off blocks), JWTs, bare `Bearer` tokens, Google `AIza`, Slack `xox[abprs]-`, GitLab `glpat-` and GitHub `ghs_/ghu_/ghr_` keys, `token=` / `GITHUB_TOKEN:` style assignments (only values that look generated) and prefixed key names such as `DB_PASSWORD` or `AWS_SECRET_ACCESS_KEY`. Counters such as `max_tokens` and ordinary prose stay unchanged.
- Reply previews and the reply renderer stay linear on hostile Markdown: a preview reads only the first 4000 characters with bounded patterns, link text can no longer contain `[`, and headings, list items and quotes are parsed without overlapping quantifiers (60,000 unclosed `[` took 3 s, a padded heading 8 s; now a few milliseconds). Headings keep a `#` that has no space before it (`## C#`), and CRLF line ends are dropped.
- Budgets with an explicit cut notice: the Token import tracks at most 20,000 logs totalling 64 GB (newest first), keeps at most 750,000 dedupe keys and visits at most 250,000 directory entries per scan; a scan cut short keeps the logs it did not reach. A heavy host is about 600 logs, 4.7 GB and 61,000 keys. Logs are opened with `O_NOFOLLOW`, so a tracked log replaced by a symlink is not read. 定时运行 reads at most 2,000 schedule files and 50,000 Agent records (256 MB each) per scan and says when it skipped some.
- `PASEO_HOME` is resolved by one function for reading schedules and writing plugin data: an absolute path or `~/…`; anything else falls back to `~/.paseo` and is logged once. Before, a `~/` value was honoured for schedules but not for plugin data.
- The plugin data directory is created 0700 and tightened when it already exists with wider permissions; the schedule ledger's temporary file has a random name and is created exclusively with mode 0600.
- A schedule without a name or title is stored in the ledger as 未命名定时任务 plus its short id instead of the start of its prompt; the live list still shows the prompt's start.
- Requests to the host held while its session is closed leave the queue when they time out, and the queue has its own cap of 16.
- Development preview: a malformed request target gets 400 instead of an unhandled rejection; the Playwright config and the preview server read the same `OBSERVATORY_PREVIEW_PORT`; the optional fontconfig directory is created with `mkdtemp`.

## 2.11.0 — 2026-10-09

Open-source preparation. Existing installs keep what they show and store.

- Token 页 also finds the logs of custom providers that keep them elsewhere. A provider that extends Claude Code or Codex and sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in its `env`, on its command line (`NAME=…`) or in its launcher script adds that directory's `projects` / `sessions` folder. The daemon's provider config is read through the plugin API at most every 5 minutes; a launcher is read as text (at most 64 KB, no binaries, never run) for literal assignments only, and no other env value is read. A directory found after the first import counts its whole history once instead of taking older calls for copied history, and it is remembered across restarts. Providers that use the standard directories behave as before.
- 智能分析 has a new default for new installs, 自动选择: the Grok CLI when it is installed, otherwise an enabled Claude Code or Codex provider (then a custom provider that extends one) with its default model, run like a provider chosen by hand; other providers are never picked automatically. A saved choice, the Grok CLI included, is kept. Errors that suggested 改用内置 Grok 4.7 now point to 分析设置, and a queued job names the runner it waits for instead of Grok.
- Copy no longer names one particular setup's providers; the Token page's ⓘ explains which directories it reads.
- Manifest: display name, icon and screenshots; requires Paseo `>=0.11.1`, with the SDK packages pinned to 0.11.1. The `build` step is gone: the plugin has no runtime dependencies and Paseo compiles it, so a Git install no longer installs the development tools.
- New `OVERVIEW.md` (the registry listing page) and `NOTICE` (the MIT notice for the link-opening code 定时运行 adapts from panrafal's schedule-runs). The preview, its fixtures and the tests use invented projects, providers and models only.

## 2.10.0 — 2026-10-09

- 执行中 now includes sessions whose own turn has ended while their subagents keep working (后台执行中). Claude Code runs Task subagents in the background: the lead hands the work over, ends its turn and the subagent keeps going for many minutes. Paseo shows this as "1 working" and counts the workspace as running, but the observatory only knew the session's own status, so such a session was listed as 已完成 / 未读 / 空闲 and 执行中 showed one session too few. It is now 执行中 with a 后台 mark: a blue 「后台 · <task>」 chip on its row, 「后台 1:35」 where the turn timer would be (when the subagent's start is known), and a note in the detail header (这一轮已结束，后台还有 N 个子任务在执行) with 查看子任务. It no longer counts as 未读 / 待回复 / 需要处理 while the work goes on. Approvals, errors and sessions still starting keep their own state.
- Server: a tracker follows the host's `agent.provider_subagents.update` session events (`observeEvents`). It reads the per-Agent subagent list only after the stream opens or reconnects, every 10 minutes, and once a minute for Agents with running subagents (to catch an end it missed). That list makes the host load an Agent that is not loaded (ACP providers then replay the whole session and it looks freshly updated), so only Agents the directory shows as loaded — anything but 已关闭 — are ever asked. New `observatory.background.get` (revisioned; unchanged polls are a few bytes); the page reads it every 10 s while in the foreground and at once on directory activity (a turn that just ended). The page does not subscribe to subagent events itself: that stream carries every subagent's output rows, too much to relay to a phone.
- 看板's 执行中 / 未读 / 待回复 are current between directory walks (once a minute): a turn that started or ended since the walk counts from its lifecycle hook, a new Agent counts as soon as its turn starts, and an Agent still working in the background is 执行中 (not 未读 / 待回复). A hook-only turn older than the walk, whose Agent the walk no longer lists, is no longer counted. The board also refreshes on directory activity instead of only every 30 s.
- 执行中 (chip and status filter) also counts sessions still starting (启动中), as its list section already did.
- Detail: 结果 re-reads every 5 s only while the session's own turn runs; a session working only in the background labels its last reply 本轮结果.

## 2.9.1 — 2026-10-09

- Fix: 定时运行 showed no runs on a host whose schedule Agents belong to removed projects. Paseo 0.11's agent list (`paseo.agents.list`, the daemon's `fetch_agents`) leaves out every Agent whose workspace's project no longer exists, and every scheduled run gets a workspace of its own, so all runs of a schedule whose project was removed were invisible (the 2.9.0 checks read the records directly and missed it). The index now also reads Paseo's Agent records (`$PASEO_HOME/agents/<folder>/<id>.json`, read-only; the folders are listed at most once a minute and a record is parsed again only when it changes) for the Agents the host does not list that a schedule created, or that a schedule, a run or the ledger points at (a heartbeat's target). Their runs are listed and rebuilt again. The host cannot open those sessions or workspaces any more (it shows "Workspace 不可用"), so 运行详情 says so instead of offering 打开会话 / 打开工作区; 读取会话记录 stays.
- Fix: the ledger's temporary file is unique per write (two indexes sharing a directory overwrote each other's file and one rename failed with ENOENT), and stopping the plugin saves pending changes once and then stops the write timer. Tests close every index before removing their directories and collect warnings instead of printing them.

## 2.9.0 — 2026-10-09

- 定时运行 (new sidebar page, also 打开定时运行 in the Command Center): every run of every Paseo schedule on this host, newest first and grouped by day — 执行中 (blue, spinning, with a live timer), 成功, 失败 (red, with the error in Chinese: 工作目录已不存在 / Agent 在等你审批 / daemon 重启 / Provider 启动超时 / 会话无法恢复 …, the original text one tap away) and 结果未知. The header sums the last 7 days (runs, failures, success rate); 失败 / 执行中 / 成功 chips filter; schedule cards (last 10 runs as a health strip, cadence, next run, failures) filter to one schedule, and the header then names that schedule and sums its own week. Phones scroll the cards sideways, wider screens show one row and fold the rest behind 另外 N 个任务.
- A run's detail shows the reply the schedule recorded (headings, lists, quotes, code, bold and tappable links), the merge or pull request it mentions (GitLab-style merge requests as `!42`, GitHub PRs as `#128`, merged ones in violet), 打开会话 / 打开工作区, the schedule's prompt and the run facts. Runs without a recorded reply offer 读取会话记录, which loads the session only when tapped.
- Heartbeats (schedules that prompt an existing Agent) are hidden by default; the 心跳 chip or 更多 → 显示心跳 shows them, with the Agent they prompted (a failed heartbeat records no Agent, so its target is used).
- Cadences read 每天 09:30 / 工作日 09:00 / 每周五 18:00 / 每 30 分钟; a cron that runs in another time zone than the device's says so (每天 02:00（UTC）— Paseo runs zone-less crons in UTC).
- 30 days or 200 runs (plus 100 heartbeat runs) load first; the footer counts what is left out and 加载更早 reads up to 500 + 250. 查看全部运行 on a run older than the window loads the longer list by itself.
- Deleting a schedule deletes its run history in Paseo. The observatory now keeps a small ledger of each run's times, status, Agent and workspace ids, the first 300 characters of its error and its link, plus each schedule's name and cadence (never the reply or the prompt), so deleted schedules' runs stay listed (任务已删除). Runs from schedules deleted before 2.9 are rebuilt from the Agents Paseo labelled (`paseo.schedule-id` / `paseo.schedule-run`). The ledger keeps the newest 3000 runs within 400 days; a corrupt or oversized ledger is set aside as `schedule-ledger.corrupt-<time>.json` and rebuilt, and one that cannot be read is never overwritten.
- 会话 and 已归档会话 mark sessions a schedule created with a violet 定时 badge (they stay where they are). Their 结果 tab starts with a 定时任务 card (schedule, cadence, this run, duration, 查看全部运行 opens 定时运行 on that schedule). For archived ones the recorded reply is shown first without loading the session; 读取完整结果 loads it on demand (when nothing was recorded, e.g. the schedule was deleted before 2.9, the session is read as before). When a schedule Agent's session cannot be read (an ACP session that cannot be resumed, a missing log), its 结果 tab shows the recorded reply under a short notice instead of an error, and stops re-reading the session every 30 s until you tap 重试读取会话.
- A run that has just started can open its Agent right away, before the host directory (walked once a minute) names it.
- Results render Markdown lists (nested, numbered), quotes and links, and links open in the browser (http(s) only).
- 结果 shows known host errors in Chinese (e.g. 会话无法恢复：这个 ACP Agent 不支持重新载入 instead of "acp does not support ACP session resume"); other errors are shown as they are.
- Fix: on Paseo 0.11, pages opened from inside the plugin (查看全部运行, the 已归档会话 / 返回观测台 menu items) were titled with their ids (schedule-runs, archives, observatory). They now register with titles (`addScreen`, falling back to `addSurface` on older hosts).
- Server: `observatory.schedules.list` (revisioned; the window edge moves in 10-minute steps, so unchanged polls are a few bytes) and `observatory.schedules.run` (one run's recorded reply, prompt and row, read on demand). Schedules are read from `$PASEO_HOME/schedules/*.json` and workspace names from `projects/workspaces.json`, read-only and cached by modification time; Agents come from the shared one-minute directory walk. The page polls only while it is on screen and the app is in the foreground: every 10 s while a run is going, otherwise every 45 s.

## 2.8.0 — 2026-09-23

- 待回复 now means the Agent is asking you something: the final reply of its last turn hands the next step to you (要不要继续, which option, confirm, send the output …) and you have not answered yet. Before, 待回复 was the fallback for any stopped Agent whose turn end the plugin had missed, so finished sessions showed up there while real questions were shown as 已完成. An unopened question also counts as 需要处理; once you reply it clears.
- New 空闲 state (grey): stopped, and no result is known for its last turn.
- The server decides from the final reply when a turn ends and keeps only the yes/no, never the reply text. A turn whose end the hooks missed (a queued follow-up, a plugin reload) is read from the timeline tail within a minute if the session is loaded in the host, otherwise when you open it; it counts as completed when a final reply follows your last message. Sessions that are not loaded are never read in the background (the host would load and replay them).
- Fix: a turn end whose start was never delivered no longer leaves the session stuck on an older turn.
- 看板's 待回复 count uses the same rule as the session list (it used to count every stopped session you had read).

## 2.7.1 — 2026-09-23

- Fix: in the phone / foldable app the 会话 search box no longer overlaps the filter chips. The shared kit's search field used `flex: 1`, which on native layout collapses the row it sits in, so the chips were drawn over it (web was unaffected).
- Search text is no longer saved to the server or synced between devices. A search typed on one device (or left by an older version) emptied the list on the others; it now lasts for the current app session only. Named saved views still keep their search.

## 2.7.0 — 2026-09-23

- 智能分析 opens on a new 总览: for the last 7 / 30 days, a gradient hero with the headline, report / open-problem / resolved / blocked tiles, a daily health chart, problem types by severity, open problems and the Agents that need a look — all counted with your 仍存在 / 已解决 / 误判 marks.
- 建议: the analysing model reads the recent reports and writes cross-Agent themes (new / recurring / improving) and actionable suggestions with impact, effort, scope and the reports they rest on (tap to open). 复制指令 copies a rule for AGENTS.md / CLAUDE.md; 交给 Agent starts a new Agent in the chosen project's workspace with the chosen profile and an editable task; each suggestion can be adopted, done or dismissed. With automatic analysis on, suggestions refresh after 3 new reports (at most every 20 hours).
- Who analyses is your choice (分析设置): the built-in Grok 4.7 · xhigh stays the default; any Paseo profile, or a provider + model + thinking level, runs as a temporary sub-agent of the analysed Agent in its workspace, in the provider's safest mode (Codex read-only sandbox, Cursor Ask …) with every tool permission prompt denied, and is archived as soon as the report is written ("打开分析会话" shows it). 更多 → 换个模型分析 overrides it for one run.
- Automatic analysis is off by default; 2.7 switches earlier saved settings off once. Turn it back on in 分析设置.
- 发给这个 Agent: send one finding back to the analysed Agent as an editable follow-up message.
- Fix: Grok analyses no longer fail with "max turns reached" (10 of the last 74 reports did): the CLI gets up to 3 tool-less turns to repair output that misses the schema, and when a model writes its answer twice the last one that fits the schema is used. Chinese characters split between two output chunks no longer turn into "���".
- Server: `observatory.insights.overview` (revisioned roll-up, ~15 KB, unchanged polls ~100 B), `observatory.insights.suggest / suggestions / suggest-cancel / action-feedback` (suggestion jobs share the analysis queue and runner), `observatory.insights.runners / models` (profiles from the daemon config, providers from the cached provider snapshot — no provider probes); settings file version 2.

## 2.6.0 — 2026-09-23

- Token 页 (new tab): personal token statistics for 7 / 30 / 90 days from the local Claude Code and Codex session logs (custom providers that extend them included) — today's total with a live speed badge, a 实时流速 chart (10 s buckets over 30 or 60 minutes, output spread over each call's response time, sessions writing right now with their tok/s), KPI tiles (total, output, cache reads / writes, fresh input, cache hit rate, output speed, calls), daily stacked trend (总量 / 非缓存 / 输出 / 速率), composition donut, model / harness / project breakdowns, the sessions that used the most tokens, hour-of-day distribution and records. Calls are deduplicated across resumed and forked sessions; only counters, model names, working directories and session ids are kept.
- 复盘 (new agent-detail tab): the agent's whole execution folded server-side into key numbers, an 执行时间轴 Gantt (one row per kind of work — thinking, reading, searching, editing, commands, web, sub-agents, plans, approval waits — turns side by side with long idle gaps folded, tap a turn to zoom and a block for its details), 重点 (failed and then fixed tests, failure streaks, slowest commands, long thinking, approval waits, big edits, commits and pushes, sub-agents, compactions, the turn that used most tokens), 时间都去哪了, 按轮回顾 cards with a per-turn barcode, 命令与检查, 动过的文件 and per-call tokens. Every block, highlight and check jumps to its raw row in 时间线.
- Server: `observatory.tokens.get` / `observatory.tokens.live` read the provider logs incrementally in the background (hot files every 2 s, discovery every 30 s) into `tokens.json` (hourly buckets for 92 days, daily for 400); `observatory.digest.get` folds the host's projected timeline (tool start times are estimated from the preceding entry) into a revisioned payload under 59 KB.
- Running session rows show their live output speed (tok/s); 看板's hero links to today's tokens.
- Detail tabs scroll sideways on phones instead of clipping.

## 2.5.0 — 2026-09-23

- Six views in a colourful tab bar: 会话 · 看板 · 明细 · 横评 · 事件 · 分析. The selected view is a gradient pill; on phones the others are coloured icons (their names stay in the accessibility labels).
- 看板 (personal statistics for 7 / 30 / 90 days in your time zone): a gradient hero with today's turns and work time, streak, level and live counts (执行中 / 待审批 / 未读 / 待回复 open the matching sessions); eight KPI tiles with change against the previous period and sparklines; a year calendar heatmap; 18 growth badges and levels; a daily trend with a 7-day average and a weekday-baseline forecast; records (longest turn, busiest day, peak parallel Agents, busiest session, peak hour); a weekday × hour punchcard; the model mix as a donut.
- 明细: models, vendors, harnesses and projects ranked by turns, sessions, time, tool calls or code, with a top-three podium, a composition bar and per-row success rate, average turn, tools per turn, lines added/removed and context use; tools by kind and the most used tools; a time-and-output summary. 观测 keeps the earlier observation charts (activity heatmap, daily results, usage snapshots).
- 横评: two models, harnesses or vendors head to head — a score, a six-axis radar (产出 / 速度 / 稳定 / 自主 / 省心 / 活跃), earned titles (更稳 / 更快 / 更高产 …) and paired bars for 产出 / 效率 / 质量 / 投入; swap sides or pick either side.
- 事件: a 并行泳道 swimlane of the last 1 / 6 / 24 hours — one lane per Agent, turns as bars (green done, red failed, blue still running with a pulse), approval waits as amber strips, and the peak number of Agents working at once.
- 已完成 and 待回复 no longer look alike: every state has its own colour, glyph and label (待回复 violet speech bubble, 已完成 green check, 未读 pink, 待审批 amber, 异常 red, 执行中 blue), every waiting row carries a tag, a 待回复 quick scope was added, and 图例 explains the marks. `statusNames.idle` is now 待回复.
- Kit v3 palette: brighter neon-like shades on dark themes, new sky / lime / fuchsia hues, gradient and glow helpers; text colours keep ≥ 4.5:1.
- Server: `observatory.stats.get` returns a compact, revisioned statistics snapshot (unchanged polls cost a few bytes). Sessions come from Paseo's directory including archives; turns, time and parallelism from the plugin's own observation; messages, tool calls and edited lines from each turn's new timeline items. Persisted in `stats.json` with bounded history.

## 2.4.0 — 2026-09-23

- Vivid colours on the shared kit v2 palette instead of Paseo's muted status colours: running blue, waiting amber, failed red, done green, in dark and light themes (text variants keep ≥ 4.5:1).
- Every view has its own colour: 会话 blue, 数据洞察 violet, 事件流 orange, 智能分析 pink; detail tabs 结果 green, 时间线 blue, 子任务 violet, 诊断 orange, 分析 pink.
- Projects get a stable colour (`hueFor`, the same in every plugin): a dot in each session row, a coloured initial in the detail header, project sheets and project rankings; selected project chips take the project's colour.
- Section labels in results and diagnostics carry coloured icons; filter chips for states use the state colours; git parts (worktree, branch) are violet.
- Analytics: green activity heatmap (violet for output, red for failures), coloured headline numbers, vivid daily bars, project bars in project colours; the events pulse is orange.

## 2.3.0 — 2026-09-23

- Distinct status marks instead of same-looking dots: running is a turning blue ring with a per-second timer, approvals a filled amber mark that radiates, errors red, unread results a filled green check; idle, read, closed and canceled sessions are grey outlines with lighter titles. Running gets its own blue because Paseo's accent is the same green as success.
- Rows that need you or are running carry a coloured edge and a tinted pill (待审批 2, 异常, 未读, 失败 N 次, 久无更新). Group headers, quick-scope chips, sub-agent toggles, subtasks and the detail header's status pill use the same marks.
- Motion only where something happens: a row flashes in its new colour when its state changes, new events slide into the feed, running details show a sweeping progress bar, the 实时 dot radiates while live, analytics bars grow in when shown.
- Web animations are CSS keyframes (no JavaScript per frame); native uses the native driver. Loops pause in the background and stop entirely under the system's reduced-motion setting.

## 2.2.0 — 2026-09-23

- UI redesign on the shared plugin kit (`client/kit.tsx`): no hero, harvest banner or stat cards; the first session row now starts about 125 px below the top of the surface on phones and desktop, down from 650–700 px.
- One toolbar row: 会话 / 数据洞察 / 事件流 / 智能分析, search, and a “···” menu for archives, list/tree, sort order, expand all, snapshot export and refresh.
- Quick scopes 需要处理 / 执行中 / 未读 (plus 稍后处理 while anything is snoozed), project and time-range chips, a 筛选 sheet with saved views, and removable chips for applied filters.
- Sessions are grouped 需要处理 → 执行中 → 最近 by whole thread. Each row shows one badge (approval, repeated failure, error, unread/snoozed, quiet); unread descendants show on the sub-agent toggle.
- Detail: split view from 760 px, a pushed page with a bottom action bar on phones. 打开会话 (处理审批 / 恢复会话) is the one primary action, 已读并看下一个 sits next to it, the rest is in “···”. Only the runtime line re-renders on the clock.
- Explanations moved to ⓘ sheets, menu hints and the README; confirmations are toasts, errors are one-line banners with retry.
- Analytics restyled: single-hue heatmap with a 少→多 legend and 未采集 cells, thin daily bars in status colours with a legend, neutral project bars, two-column stats on phones.
- Additive preference field `focus` (`"all" | "attention"`), optional so views stored by older versions load unchanged and older servers ignore it.
- Preview uses the exact host themes, real Lucide icons, and host-like sheets and toasts; `lucide-react` added as a dev dependency.

## 2.1.0 — 2026-09-22

- Require Paseo `>=0.9.0`; SDK packages pinned to 0.9.0.
- Agent directory follows an owned 0.9 observation (`agents.list({ subscribe: {} })`, one-entry snapshot) instead of re-listing every agent every 5 s; full reads only on open, foreground, reconnect, a 10-minute safety interval, or 15 s fallback polling while no observation is available. Hidden views release it.
- Revisioned telemetry (unchanged or delta replies), analytics (unchanged replies carry the open coverage interval; only rendered usage samples are sent), read receipts, insight lists (content revision) and agent results.
- Analytics loads only while its tab is visible; `inactive` app state pauses polling like `background`; dashboard filters recompute only at range/snooze boundaries and rows are memoized.
- Timeline subscriptions follow 0.9 semantics: re-read after `subscription_restored`, re-subscribe with backoff after `error`, never stitch a non-contiguous tail.
- Raw IPC bridge: skip parsing unrelated host frames, fail in-flight requests immediately when the host closes the plugin session, hold new ones until it re-attaches.
- Persistence: idle heartbeats no longer rewrite and fsync `telemetry.json` every 30 s; unchanged usage samples and identical payloads are not written; the insight index is rewritten only when its content changes.

## 2.0.1 — 2026-09-17

- Keep Open Paseo conversation in the fixed detail header for every session state and tab, including unread result pages.
- Show navigation failures in the same visible header and remove duplicate navigation actions from scrolling content.

## 2.0.0 — 2026-09-17

- Results-first session and native subagent views: pinned initial input, latest reply, result evidence.
- Version-aware read-and-next queue, one-hour snooze, archive-read flow.
- Saved views and reading positions; independent scrollable filters.
- Shared bounded timeline cache, virtualized history/subtasks, attention-first directory paging.
- Archive/read provenance and background pagination correctness.
- Separate insight settings/index/reports, large-history migration, independent cooldown and skip retention.
- Lazy report loading, source freshness, incremental follow-ups and finding feedback.
- Online coverage intervals and project-attributed analytics.

## 1.2.0 — 2026-09-17

- Completed-unread harvest queue, native read acknowledgement and versioned receipts.

## 1.1.0 — 2026-09-17

- Separate archives, worktree/branch identity and responsive visual redesign.

## 1.0.0 — 2026-09-16

- Initial agent dashboard, lifecycle telemetry, nested subagents and AI trajectory review.
