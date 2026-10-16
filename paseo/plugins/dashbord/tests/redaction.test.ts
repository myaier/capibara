import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../server/redaction";
import { summarizeTrajectoryRow } from "../server/trajectory";
import { normalizeTimelinePage } from "../shared/timeline";

/** Every case below is synthetic: shapes of real credential formats, never real values. */
const leaks = (text: string, secret: string) => redactSecrets(text).includes(secret);
// Fake credentials are assembled at run time so the source never carries a token-shaped literal that a host's secret scanner would flag.
const fake = (prefix: string, body: string) => `${prefix}${body}`;
const PEM_BODY = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaCVY8m0aSyLwqYq";
/** PEM armour lines, assembled so the source holds no literal key header. */
const armour = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;

test("PEM private key blocks are removed whole, including JSON-escaped and cut-off ones", () => {
  for (const kind of ["RSA PRIVATE KEY", "PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const block = `${armour("BEGIN", kind)}\n${PEM_BODY}\n${PEM_BODY.split("").reverse().join("")}\n${armour("END", kind)}`;
    const redacted = redactSecrets(`key file:\n${block}\ndone`);
    assert.equal(redacted.includes(PEM_BODY), false, kind); assert.match(redacted, /\[private key redacted\]/); assert.match(redacted, /^key file:\n[\s\S]*\ndone$/);
  }
  assert.equal(leaks(JSON.stringify({ private_key: `${armour("BEGIN", "PRIVATE KEY")}\n${PEM_BODY}\n${armour("END", "PRIVATE KEY")}\n`, client_email: "bot@example.com" }), PEM_BODY), false);
  // An excerpt can end inside the key: everything after the header goes.
  assert.equal(leaks(`${armour("BEGIN", "OPENSSH PRIVATE KEY")}\n${PEM_BODY}`, PEM_BODY), false);
  // Certificates and public keys are not secrets.
  const certificate = `${armour("BEGIN", "CERTIFICATE")}\n${PEM_BODY}\n${armour("END", "CERTIFICATE")}`;
  assert.equal(redactSecrets(certificate), certificate);
  assert.equal(redactSecrets(`${armour("BEGIN", "PUBLIC KEY")}\n${PEM_BODY}\n${armour("END", "PUBLIC KEY")}`).includes(PEM_BODY), true);
});

test("JWTs are masked wherever they appear", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkRlbW8ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  for (const text of [jwt, `cookie: session=${jwt}; Path=/`, `https://app.example.com/callback?id_token=${jwt}&state=1`, `"Authorization": "Bearer ${jwt}"`]) assert.equal(leaks(text, jwt.split(".")[2]), false, text);
  assert.equal(leaks("unsigned eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"), false);
  // A value masked by one pattern is not masked again by the key patterns.
  assert.equal(redactSecrets(`"Authorization": "Bearer ${jwt}"`), '"Authorization": "Bearer [credential redacted]"');
  assert.equal(redactSecrets(`OPENAI_API_KEY=sk-${"a1".repeat(12)}`), "OPENAI_API_KEY=[credential redacted]");
});

test("a bare Bearer token, Google, Slack and GitLab keys are masked", () => {
  const cases: Array<[string, string]> = [
    ["curl -H 'X-Api: Bearer d4f1c9b2a7e64f0b9c3e8a1d5b7f2c6e' https://api.example.com", "d4f1c9b2a7e64f0b9c3e8a1d5b7f2c6e"], // privacy-check: allow (fictional token)
    ["bearer   abcdefghijklmnopqrstuv.wxyz-0123", "abcdefghijklmnopqrstuv"],
    [`GOOGLE_MAPS=${fake("AIza", "SyD3m0-k3yF0rT3stingOnlyXXXXXXXXXXXX")}`, fake("AIza", "SyD3m0-k3yF0rT3stingOnlyXXXXXXXXXXXX")],
    [`key ${fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")}`, fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")],
    ...["xoxb", "xoxp", "xoxa", "xoxr", "xoxs"].map((prefix): [string, string] => [`slack ${prefix}-1234567890-0987654321-AbCdEfGhIjKlMnOp`, `${prefix}-1234567890-0987654321-AbCdEfGhIjKlMnOp`]),
    [`git clone https://oauth2:${fake("glpat-", "AbCdEfGhIjKlMnOpQrSt")}@git.example.test/acme/app.git`, fake("glpat-", "AbCdEfGhIjKlMnOpQrSt")],
    [`export CI_TOKEN ${fake("glpat-", "xY9_zW8-vU7tS6rQ5pO4")}`, fake("glpat-", "xY9_zW8-vU7tS6rQ5pO4")],
    [`gh auth: ${fake("ghs_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")}`, fake("ghs_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")],
  ];
  for (const [text, secret] of cases) assert.equal(leaks(text, secret), false, text);
});

test("token, secret and password assignments are masked in env, YAML, JSON, URL and header forms", () => {
  const cases: Array<[string, string]> = [
    ["token=abc123def456", "abc123def456"],
    ["TOKEN: s3cr3tvalue1", "s3cr3tvalue1"],
    ["export GITHUB_TOKEN=gho16charsonly", "gho16charsonly"],
    ['{"token": "AbCdEf9hIjKlMnOpQrSt"}', "AbCdEf9hIjKlMnOpQrSt"],
    ["session_token=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"],
    ["callback?token=7e2f9a1c44b8d6e0&next=%2Fhome", "7e2f9a1c44b8d6e0"],
    ["x-auth-token: 9f8e7d6c5b4a", "9f8e7d6c5b4a"],
    ["https://api.example.com/v1?access_token=Zx81Yw72Vu63&page=2", "Zx81Yw72Vu63"],
    ["DB_PASSWORD=correct-horse-battery", "correct-horse-battery"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["SECRET_KEY='django-insecure-0123456789'", "django-insecure-0123456789"],
    ["client_secret: 7c4a8d09ca3762af61e59520943dc26494f8941b", "7c4a8d09ca3762af61e59520943dc26494f8941b"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw=="],
    ["apiKey: 'k-0123456789abcdef'", "k-0123456789abcdef"],
  ];
  for (const [text, secret] of cases) assert.equal(leaks(text, secret), false, text);
});

test("ordinary text, counters and documentation about credentials stay unchanged", () => {
  const ordinary = [
    "input_tokens: 123456, output_tokens: 7890, max_tokens=4096, total_tokens: 131442",
    "Tokenizer: bert-base-uncased; tokens: 512",
    "The secretary: Alice Johnson. Secrets: none were found.",
    "passwords are hashed with bcrypt; password_hash is a column name",
    "Send a Bearer token in the Authorization header; the token: everything else is public",
    "JWTs start with eyJ because they encode JSON. AIza keys, xoxb- bot tokens and glpat- tokens are prefixes worth scanning for.",
    `${armour("BEGIN", "CERTIFICATE")} is not a secret`,
    "sk-learn and pk-sharding are package names; ghp_ is the GitHub prefix",
    "令牌：请在设置里填写；密码长度至少 8 位。",
    "commit 3f2c1e9 fixed the token refresh: retries now back off",
    "const token = knownCompletionAt(agent); const token = JSON.stringify([a, b]); token = Date.parse(at); token = someVariableName;",
  ];
  for (const text of ordinary) assert.equal(redactSecrets(text), text);
});

test("redaction is linear on hostile input", () => {
  const n = 60_000;
  for (const [label, text] of [["eyJ runs", "eyJ-".repeat(n / 4)], ["dotted eyJ", "eyJaaaaaaaaaaaaa.".repeat(n / 17)], ["PEM headers", armour("BEGIN", "PRIVATE KEY").repeat(n / 27)],
    ["token keys", "token: ".repeat(n / 7)], ["bearer words", "Bearer ".repeat(n / 7)], ["assignment spaces", `password${" ".repeat(n)}x`], ["prefix runs", "sk-".repeat(n / 3)],
    ["scheme letters", "a".repeat(n)], ["schemes", "a://".repeat(n / 4)], ["userinfo colons", `a://${"b:".repeat(n / 2)}`],
    ["escaped keys", '\\"password\\": \\"'.repeat(n / 16)], ["escaped values", `password: ${"\\x".repeat(n / 2)}`], ["query keys", "?key=".repeat(n / 5)],
    ["webhook paths", "hooks.slack.com/services/".repeat(n / 25)], ["SendGrid dots", "SG.".repeat(n / 3)], ["SendGrid body", `SG.${"a".repeat(n)}`],
    ["escapes", "\\n".repeat(n / 2)], ["escaped prefixes", "\\nsk-".repeat(n / 5)]] as const) {
    const started = performance.now(); redactSecrets(text); const took = performance.now() - started;
    assert.ok(took < 250, `${label} took ${took.toFixed(0)} ms`);
  }
});

// leak-1014: formats the patterns missed, JSON escaping, and secrets parted from their prefix by an excerpt cut.
const BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
test("npm, temporary AWS, Slack app and refresh, Google OAuth, GitLab, Hugging Face, SendGrid, Stripe, Groq and Composio keys are masked", () => {
  const keys = [fake("npm_", BODY), fake("ASIA", "Q2W3E4R5T6Y7U8I9"), fake("xapp-", "1-A0123456789-0123456789012-abcdef"), fake("xoxe-", "1-AbCdEfGhIjKlMnOp"),
    fake("ya29.", "a0AfH6SMBxAbCdEfGhIjKlMnOpQr"), fake("GOCSPX-", "AbCdEfGhIjKlMnOpQrStUvWx"), ...["gldt-", "glrt-", "glptt-"].map(prefix => fake(prefix, "AbCdEfGhIjKlMnOpQrSt12")),
    fake("hf_", BODY), fake("SG.", "AbCdEfGhIjKlMnOpQrStUv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg"), fake("rk_live_", "AbCdEfGhIjKlMnOpQrStUvWx"),
    fake("whsec_", "AbCdEfGhIjKlMnOpQrStUvWx12"), fake("gsk_", `${BODY}AbCdEfGh`), fake("ak_", "AbCdEfGhIjKlMnOpQrSt")];
  for (const key of keys) for (const text of [`value ${key} end`, `export TOKEN_VALUE=${key}`]) assert.equal(leaks(text, key), false, text);
});

test("a password in any URL scheme, webhook paths and signed query values are masked", () => {
  const password = "Pa55-w0rd-QX7";
  for (const url of [`postgres://app:${password}@db.internal:5432/app`, `mysql://root:${password}@127.0.0.1/db`, `mongodb+srv://user:${password}@cluster0.example.net/test`,
    `redis://default:${password}@cache:6379`, `amqp://guest:${password}@mq/vhost`, `jdbc:postgresql://app:${password}@db/app`, `DATABASE_URL="postgresql://app:${password}@db/app"`])
    assert.equal(leaks(url, password), false, url);
  const path = ["T0123ABCD", "B0123ABCD", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
  for (const url of [`https://hooks.slack.com/services/${path}`, `https://discord.com/api/webhooks/123456789012/${BODY}`]) {
    const masked = redactSecrets(url); assert.equal(masked.includes("AbCdEfGh"), false, url); assert.match(masked, /\[redacted\]$/);
  }
  for (const [url, value] of [[`https://maps.example.com/api/geocode?key=${BODY}&q=1`, BODY], [`https://bucket.s3.amazonaws.com/f.txt?X-Amz-Date=1&X-Amz-Signature=${"0a".repeat(32)}`, "0a".repeat(32)],
    [`https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sig=${BODY}%3D`, BODY]]) assert.equal(leaks(url, value), false, url);
});

test("JSON-escaped values and prefixes after an escape are masked", () => {
  const github = fake("ghp_", BODY), openai = fake("sk-", "proj-AbCdEfGhIjKlMnOp");
  for (const [text, secret] of [[JSON.stringify(JSON.stringify({ apiKey: "k-0123456789abcdef" })), "k-0123456789abcdef"], [JSON.stringify(JSON.stringify({ password: "hunter2-long-pass" })), "hunter2-long-pass"],
    [JSON.stringify(JSON.stringify({ token: "abc123def456" })), "abc123def456"], [JSON.stringify({ text: `line\n${github}` }), github], [JSON.stringify({ text: `col\t${openai}` }), openai]])
    assert.equal(leaks(text, secret), false, text);
});

test("ordinary URLs, short values and words that only start like a key prefix stay unchanged", () => {
  for (const text of ["postgres://localhost:5432/app and redis://cache:6379 have no password", "https://user@example.com/path names a user, no password",
    "?key=1&sig=abc are short", "the key=value pairs; signature=ok", "ak_short, hf_ and npm_install are not keys; SG.example is a domain", "C:\\Users\\me\\new\\task.txt"])
    assert.equal(redactSecrets(text), text);
});

const toolRow = (detail: Record<string, unknown>) => normalizeTimelinePage({ epoch: "e", rows: [{ seq: 1, item: { type: "tool_call", name: "exec", status: "completed", detail } }] }).rows[0]!;
test("tool payloads are masked before they are turned into JSON or cut: edits, nested arguments and a key whose header an excerpt drops", () => {
  const key = "k-0123456789abcdef";
  const edit = summarizeTrajectoryRow(toolRow({ type: "edit", filePath: ".mcp.json", oldString: '{"apiKey": "old-value-000000"}', newString: `{"apiKey": "${key}"}` }));
  assert.equal(edit.text.includes(key), false, edit.text); assert.equal(edit.text.includes("old-value-000000"), false);
  const nested = summarizeTrajectoryRow(toolRow({ type: "mcp", input: { server: "db", args: { config: JSON.stringify({ password: "hunter2-long-pass" }) } } }));
  assert.equal(nested.text.includes("hunter2-long-pass"), false, nested.text);
  // The excerpt keeps the start and the end of a long output: the key's header is in the dropped middle, part of its body at the end.
  const body = Array.from({ length: 50 }, (_, line) => `${PEM_BODY.slice(line % 20)}${line}`.slice(0, 64)).join("\n");
  const output = `${"x".repeat(3000)}\n${armour("BEGIN", "PRIVATE KEY")}\n${body}\n${armour("END", "PRIVATE KEY")}\ndone`;
  const cut = summarizeTrajectoryRow(toolRow({ type: "shell", command: "cat key.pem", output }));
  assert.equal(cut.truncated, true);
  for (const line of body.split("\n")) assert.equal(cut.text.includes(line.slice(0, 40)), false, line);
});

// Unprefixed values the patterns cannot recognise on their own: only the field name says they are credentials.
const plain = (seed: number, length: number) => Array.from({ length }, (_, index) => "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[(index * 7 + seed) % 56]).join("");
const windows = (secret: string) => Array.from({ length: secret.length - 39 }, (_, index) => secret.slice(index, index + 40));
const keeps = (text: string, secret: string) => windows(secret).some(window => text.includes(window));
test("a credential field is masked whole before a structured value is cut: long plain fields, then a token or password, in input and output", () => {
  const session = plain(3, 520), password = `correct horse battery ${plain(5, 40)}`, github = plain(11, 64), apiKey = plain(17, 48);
  const cases = [
    { type: "mcp", input: { header: "h".repeat(700), AWS_SESSION_TOKEN: session } },
    { type: "mcp", input: { header: "h".repeat(1500), password } },
    { type: "shell", output: { stdout: "l".repeat(2500), env: { GITHUB_TOKEN: github, OPENAI_API_KEY: apiKey } } },
    { type: "shell", output: JSON.stringify({ log: "l".repeat(2500), api_key: apiKey }) },
    { type: "mcp", input: { list: [{ note: "n".repeat(900), credentials: { user: "deploy", value: session } }] } },
    { type: "mcp", input: { header: "h".repeat(700), credentials: [github, apiKey] } },
  ];
  for (const detail of cases) {
    const row = summarizeTrajectoryRow(toolRow(detail));
    for (const secret of [session, password, github, apiKey]) {
      assert.equal(keeps(row.text, secret), false, `${JSON.stringify(detail).slice(0, 80)} → ${row.text.slice(-300)}`);
    }
  }
  // A number under a credential name is masked in the JSON, before the cut.
  const numeric = summarizeTrajectoryRow(toolRow({ type: "mcp", input: { db: { host: "localhost", password: 12345678901234 } } }));
  assert.equal(numeric.text.includes("12345678901234"), false, numeric.text);
  // Counters and names that only mention a credential stay readable.
  const ordinary = summarizeTrajectoryRow(toolRow({ type: "mcp", input: { max_tokens: 4096, tokenizer: "cl100k_base", secretName: "db-creds", tokens: "1234 used" } }));
  for (const text of ["4096", "cl100k_base", "db-creds", "1234 used"]) assert.ok(ordinary.text.includes(text), ordinary.text);
});
