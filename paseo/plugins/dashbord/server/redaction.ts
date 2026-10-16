// Credential shapes that are masked before excerpts leave the host. Every pattern stays linear on hostile input: a JWT
// only starts where the previous character cannot belong to it, and no two quantifiers compete for the same run. A value that
// is already a `[… redacted]` marker is left alone.
/** A PEM private key: header to footer, or to the end of the text when an excerpt cut the block. */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** header.payload.signature, both JSON parts base64url (`eyJ` is `{"`); an unsigned token has an empty signature. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
/**
 * Vendor prefixes: OpenAI/Stripe-style sk-/pk-/rk-, GitHub gh?_ and github_pat_, xAI, Groq, AWS access keys (long-term and
 * temporary), Google API keys, OAuth tokens and client secrets, Slack bot/user/app/refresh tokens, GitLab, npm, Hugging Face,
 * SendGrid, Stripe webhook secrets, Composio. A prefix also counts right after a JSON escape such as `\n`.
 */
const PREFIXED = /(?:\b|(?<=\\[nrt]))(?:(?:sk|pk|rk|gh[pousr]|github_pat|xai)[-_][A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gl(?:pat|dt|rt|ptt|cbt|ft|oas|soat|imt|agent|wt)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{24,}|gsk_[A-Za-z0-9]{40,}|ak_[A-Za-z0-9]{20,})/g;
/**
 * `password=…`, `"api_key": "…"`, `Authorization: Basic …`: the value after a credential key (any prefix, e.g. `DB_PASSWORD`),
 * also in JSON that was stringified once more (`\"password\": \"…\"`).
 */
const KEYED = /((?:authorization|api[_-]?key|access[_-]?(?:token|key)|refresh[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|secret)\\?["']?\s*[=:]\s*\\?["']?)(?:(?:Bearer|Basic|Token)[ \t]+)?(?!\[)(?:[^\s"'`,;\]}\\]|\\(?!["'])){8,}/gi;
/**
 * `token=…` / `GITHUB_TOKEN: …` (not `tokens`, `max_tokens`). Only values that look generated: token characters with a digit or at
 * least 32 of them, not followed by `(`, `[` or `{` (code such as `const token = readToken(agent)` stays). The value is matched once
 * (an atomic lookahead), so a long run cannot backtrack.
 */
const TOKEN = /(token\\?["']?\s*[=:]\s*\\?["']?)(?!\[)(?=[\w.~+/=%-]*[0-9]|[\w.~+/=%-]{32})(?=([\w.~+/=%-]{8,}))\2(?![(\[{])/gi;
/** A bare `Bearer <token>` (headers in curl commands, logs). */
const BEARER = /(\bBearer[ \t]+)(?!\[)[A-Za-z0-9._~+/=-]{16,}/gi;
/** `user:password@` in a URL of any scheme (https, postgres, mongodb+srv, redis, amqp…); a scheme starts where a word does. */
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
/** Slack and Discord webhook URLs carry their secret in the path. */
const WEBHOOK = /((?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks)\/)[A-Za-z0-9_/-]{8,}/gi;
/** Signing and key parameters of a URL query (`?key=`, presigned `X-Amz-Signature=`, Azure SAS `sig=`). */
const QUERY_KEY = /([?&](?:key|sig|signature|x-amz-signature)=)(?!\[)[^\s&#"'<>]{8,}/gi;

/**
 * A field whose name says it holds a credential (`password`, `PGPASSWORD`, `api_key`, `x-api-key`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN`, `Authorization`, `client_secret`, `credentials`): every string under it is masked whole, whatever it looks
 * like, before anything is cut or turned into JSON. `max_tokens`, `tokenCount` or `secretName` are not credentials.
 */
const CREDENTIAL_FIELD = /(?:authorization|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|password|passwd|passphrase|token|credentials?)$/i;
export const isCredentialField = (name: string): boolean => CREDENTIAL_FIELD.test(name);

/**
 * Never forward common credential literals into an outgoing prompt. Not exhaustive: unknown formats, bare secrets
 * without a key or prefix (an AWS secret key on its own line) and passwords under 8 characters or with spaces pass through.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[private key redacted]")
    .replace(JWT, "[credential redacted]")
    .replace(PREFIXED, "[credential redacted]")
    .replace(KEYED, "$1[redacted]")
    .replace(TOKEN, "$1[redacted]")
    .replace(BEARER, "$1[redacted]")
    .replace(USERINFO, "$1[redacted]@")
    .replace(WEBHOOK, "$1[redacted]")
    .replace(QUERY_KEY, "$1[redacted]");
}
