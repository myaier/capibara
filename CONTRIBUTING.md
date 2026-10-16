# Contributing

This repository is public. Anything committed, including history, can be read by anyone.

## Before your first commit

```sh
git config core.hooksPath .githooks
```

The pre-commit hook runs `node paseo/scripts/check-private.mjs --staged` and refuses commits that add credentials or private identities. CI runs the same check on every tracked file and scans history with gitleaks; GitHub push protection also rejects known token formats.

## Never commit

- Credentials: API keys, tokens, passwords, private keys, `.env` files.
- Machine identities: real host names (`DESKTOP-…`), IP addresses, Paseo server IDs (`srv_…`), session or agent IDs from real machines.
- Personal paths and addresses: `/Users/<name>/…`, `/home/<name>/…`, work or personal email addresses.
- Real usage data: token counts, session counts and titles, conversation content, screenshots of real sessions.

Use fictional values instead: `example.com`, `192.0.2.x`, `srv_demo…`, `WIN-DEMO-PC`, `/Users/<name>`. Keep acceptance evidence, logs and machine notes in `.private/` (ignored by Git). If a match is genuinely public, put `privacy-check: allow` on that line.

If something private was pushed, tell a maintainer immediately: removing it from the next commit is not enough, history has to be rewritten and any credential rotated.

## Branches and pull requests

`main` is protected. Work on a branch, open a pull request, and wait for the `privacy` check to pass. Development commands are in [README.md](README.md#development).
