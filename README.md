# Capibara / Paseo plugins

Capibara continues development from [`zhjiang22/paseo-plugins`](https://github.com/zhjiang22/paseo-plugins). It is based on upstream Agent Observatory 2.16.0 (upstream commit `22941e0`); Capibara's own Git history starts fresh and does not share history with upstream.

- Development repository (`origin`): `myaier/capibara`
- Upstream (reference only, no shared history): `zhjiang22/paseo-plugins`
- Default branch: `main`
- Dashboard source: [`paseo/plugins/dashbord`](paseo/plugins/dashbord)
- Dashboard installable snapshot: [`dashbord`](dashbord)
- Investigation: [Why the observatory does not show sessions from every host](docs/agent-observatory-session-scope.md)

The plugin retains its upstream license and notices.

The observatory merges every connected machine in the original panels, without a machine picker. Business filters apply to the merged data. The separate all-host home page was rejected and has been removed. The current rollout status and acceptance gates are tracked in [the development checklist](docs/multi-host-todo.md). Development builds are not evidence of completed cross-host acceptance.

Agent Observatory `2.18.0-dev.4` adds right-click/long-press session menus for renaming and archiving, plus background naming with an available lightweight model. Manual names are preserved. See [session actions and validation](docs/session-actions.md).

## Scope

This repository maintains one plugin: **Agent Observatory** (runtime ID `agent-observatory`), a results-first dashboard for every Paseo agent and subagent: unread queue, timelines, usage and token statistics and scheduled runs. Source lives in [`paseo/plugins/dashbord`](paseo/plugins/dashbord); the installable snapshot is [`dashbord`](dashbord).

The upstream repository also carries Project Notes, Server Browser, Vivid Activity and Terracotta Themes. They were removed from Capibara on 2026-10-16 because nothing here depends on them; install them from [`zhjiang22/paseo-plugins`](https://github.com/zhjiang22/paseo-plugins) if needed. Upstream changes are ported by hand.

The plugin declares its Paseo requirement in `requirements.paseo` (Paseo 0.11.1 or newer). Read [`OVERVIEW.md`](paseo/plugins/dashbord/OVERVIEW.md) for what it reads, writes and runs.

## Languages

Agent Observatory has English and Simplified Chinese built in and follows the system language by default; other device languages show English. It has a **Language** setting under Settings → Plugins.

To add a language, for example Korean:

1. Open the plugin's language folder on the daemon host: `~/.paseo/plugin-data/agent-observatory/locales/` (under `$PASEO_HOME` if you set it). The Language setting shows the exact path.
2. Copy `templates/en.json` from that folder to `ko.json`, set `$meta.name` to the language's own name and translate the values. Keep the message ids and `{placeholder}` names; plural messages use CLDR forms (`one`, `other`, …).
3. Press **Reload** in the Language setting, then choose the language. Missing or invalid entries fall back to English, and the setting lists coverage and any problems.

The plugin's [README](paseo/plugins/dashbord/README.md) has the details. A built-in language is welcome as a pull request: `shared/locales/<code>.json` plus one line in `server/locales.ts`.

## Install

Install the dashboard from this repository on the machine running the Paseo daemon:

```sh
paseo plugin add git:myaier/capibara:dashbord
```

In Paseo Settings → Plugins, paste `https://github.com/myaier/capibara:dashbord`. The repository is public; no Git credentials are needed. The default branch is `main`; no branch selector is needed. The installation path is `dashbord`, while the runtime ID remains `agent-observatory` so existing plugin data keeps the same identity.

The current snapshot is **2.20.0-dev.4**. The top-right entry is now **Hosts**: it lists every host Paseo is connected to with the observatory's state there (up to date, update available, not installed, disabled, too old, plugins turned off, offline and when it was last seen), updates one host or every installed host to the same revision (this page's own host last, after commands elsewhere have finished), and installs, enables or upgrades the observatory on another host, or turns plugins on there, once you confirm the commands it shows. Mobile sidebar and attention-popover navigation close the drawer before revealing the destination. Every session row leads with a small mark of its harness. The session list opens on every non-archived session grouped by state, running rows mark their harness before the 「tk/s」 speed, and reordering rows glide instead of jumping. Intelligent analysis, automatic reviews and cross-session suggestions have been temporarily removed; deterministic session recaps remain available. Automatic session naming also covers Codex sessions started with a slash command. Execution timelines show the newest records at the top; live arrivals expand smoothly and push earlier rows down, with older history loaded at the bottom. Session rows support renaming and archiving, with background generation of concise titles. Latest replies render Markdown, including local image attachments and tables, within the existing panels. The original panels now aggregate connected machines; see [scope and historical limits](docs/multi-host-observatory.md).

Paseo does not update plugins automatically. Each host's observatory checks its own installation source at most every 30 minutes while a panel is open. **Sync all** in the Hosts panel asks once, then runs each installed host's own reviewed update for the revision this page's installation offers (other hosts first) and the install, enable, upgrade or plugin switch each other host needs; **Update** on a row updates just that host, and **Not now** hides that revision's prompt. Install, enable, upgrade and turning plugins on open a terminal in one of the target host's workspaces and run `paseo plugin add` with this installation's source, `paseo plugin enable`, `paseo plugin update --yes` and `paseo plugin reload`, or `paseo daemon config set pluginsEnabled true` and `paseo daemon reload` (which starts every enabled plugin on that host). A host can still be updated on its own through its entry in Paseo Settings → Plugins or with the command below.

Full multi-host statistics require a compatible plugin backend on each machine. If `agent-observatory` is already installed from this repository, update it with `paseo plugin update agent-observatory --ref main`; do not add another installation with the same ID. Check an existing installation's source before updating a copy installed from a different repository. The `feat/multi-host-panels` branch is a development channel until its checklist is complete.

## Development

This repository is public. Read [CONTRIBUTING.md](CONTRIBUTING.md) and enable the privacy hook once per clone: `git config core.hooksPath .githooks`.

Use Node.js `22.23.3` (pinned in `.nvmrc`). Agent Observatory is an independent npm project:

```sh
cd paseo/plugins/dashbord
npm ci
npm run typecheck
npm run build
npm test
```

`npm run build` regenerates the production lazy UI, including the Hermes host-module interop fix. `npm run check:build` and the unit tests reject stale generated UI. The initial upstream export omitted this script; it is now maintained under the plugin's `scripts/` directory.

## Package an installable snapshot

Edit `paseo/plugins/dashbord/`. The root `dashbord/` directory is generated and stays unchanged during development. At release time, from the repository root:

```sh
node --test paseo/scripts/package-plugin.test.mjs
node paseo/scripts/package-plugin.mjs dashbord
node paseo/scripts/package-plugin.mjs dashbord --check
```

The packager first verifies that the lazy UI matches current source, then copies the runtime files declared in `paseo/plugins.json`, retains licenses, and records every installed file's SHA-256 in `dashbord/release.json`. It does not silently rebuild stale UI. The `--check` command checks the published snapshot's integrity independently of unreleased source edits. Before publishing, run the plugin tests and verify installation through Paseo, then commit the snapshot to `main`. Git installations read the default branch, not GitHub's latest Release.

No automated GitHub Release workflow is configured yet.

## 中文说明

本仓库只维护一个 [Paseo](https://paseo.sh) 插件：Agent Observatory（观测台，运行时 ID `agent-observatory`）。源码在 `paseo/plugins/dashbord`，安装快照在 `dashbord`。内置英文和简体中文，默认跟随系统语言，也可以在语言目录里加自己的翻译（步骤见上面的 Languages）。安装方式见上面的 Install；插件读写哪些文件、会不会联网或启动进程，写在 `OVERVIEW.md` 里。

上游仓库里的 Project Notes、Server Browser、Vivid Activity、Terracotta Themes 已于 2026-10-16 从本仓库移除，本仓库没有任何内容依赖它们；需要时请从上游 `zhjiang22/paseo-plugins` 安装。
