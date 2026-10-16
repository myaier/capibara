# Development fixture preview

This preview renders the production `DashboardView` and `AgentDetail` components through React Native Web. Only the host SDK, icons, and input records are replaced. Every screen carries a host bar marked **开发预览 · 模拟数据**; screenshots do not demonstrate a live daemon connection.

The stand-ins follow the host closely so screenshots are trustworthy: `themes.js` holds the exact Paseo dark/light theme tokens, icons are real Lucide components (`lucide-react` dev dependency; an unknown name logs a console error, the host would render nothing), `Modal` is a themed dialog on desktop and a bottom sheet on phones, and `useToast` renders toasts with `role=status`.

Run `npm run preview:build` to build `preview/dist`. Run `node scripts/build-preview.mjs --serve` to serve it on `http://127.0.0.1:4177`. This loopback-only server does not publish or contact a remote service.

Query parameters:

- `theme=light` (default is dark)
- `scenario=empty`, `error`, `retained-error`, `loading`, `stale`, `truncated`, or `read-error` (a completion acknowledgement fails without changing native attention state); detail edge cases: `navigation-error`, `long-history`, `unknown-origin`
- `archives=1` opens the independent archived-session page; normal overview always excludes archived records, including in all-time mode. Header/footer archive navigation switches between these same views.

Fixtures model a managed `payments-v2` worktree on `feature/payments-v2`, normal main checkouts, a renamed project whose workspace title is different, and older execution archived more recently. These are synthetic records that exercise the distinction between execution time, archive metadata, project names and worktree names.

The completion fixtures contain two unread results (including a nested child) and one read result. The preview uses a synthetic observable host store so explicit acknowledgement, native conversation reads, new completions, and restoration update the actual dashboard immediately. Merely opening the inspector never acknowledges a result. Development-only helpers exposed to Playwright simulate native changes; they are not available in the installed plugin.

Run `npm run test:ui` for the UI flows (`tests/ui.spec.ts`) on desktop dark/light, a 1280×720 short desktop, and 390px/320px touch phones. Playwright saves fixture screenshots in `docs/screenshots` (not part of the published package); failed-test artifacts are kept under `test-results`.

Install Playwright Chromium and its system dependencies before running browser tests. Set `OBSERVATORY_PREVIEW_FONT_DIR` only if you need a custom local font directory; otherwise the preview uses system fonts.

The preview is development tooling only. Paseo loads `index.client.tsx` and `index.server.ts`; neither imports this directory.
