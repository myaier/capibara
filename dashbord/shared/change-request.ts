import type { ChangeRequestLink } from "./telemetry";

const CHANGE_REQUEST = /https?:\/\/[^\s<>()[\]"'`]+?\/(?:pull|pulls|merge_requests)\/(\d+)(?=[^\w/]|$)/;
/** `user:token@` before the host: a push URL quoted in a reply can carry a credential, which is never kept or shown. */
const USERINFO = /^(https?:\/\/)[^/?#@]*@/i;
export const withoutUserinfo = (url: string) => url.replace(USERINFO, "$1");
/** Replies are read from the end; a request linked early in a very long reply is not worth scanning megabytes for. */
const SCAN_MAX = 20_000;

/**
 * The merge or pull request a reply links to (opus-B16): GitLab-style merge requests (`/merge_requests/12`) read `!12`,
 * GitHub-style pull requests `#34`. The last one mentioned wins: a reply that lists an older request and then the new one
 * means the new one. Only the URL (without any `user:password@`) and its label leave this function.
 */
export function findChangeRequest(text: string | null | undefined): ChangeRequestLink | null {
  if (!text) return null;
  const source = text.length > SCAN_MAX ? text.slice(-SCAN_MAX) : text;
  let found: RegExpExecArray | null = null;
  const pattern = new RegExp(CHANGE_REQUEST.source, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) found = match;
  if (!found || found[0].length > 2000) return null;
  const mr = /\/merge_requests\//.test(found[0]);
  return { url: withoutUserinfo(found[0]), label: `${mr ? "!" : "#"}${found[1]}`, kind: mr ? "mr" : "pr" };
}
