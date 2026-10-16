import { t } from "../shared/text";
import * as host from "@getpaseo/plugin/client";
import { Linking } from "react-native";

/**
 * Opens an http(s) link (a merge or pull request) in the user's browser through the host's `openExternalUrl` (Paseo 0.11):
 * the desktop app's own opener, the system browser on phones. A host without it (the preview, an older client) falls
 * back to `Linking`.
 */
type Opener = (url: string) => Promise<void>;
export function isHttpUrl(url: string): boolean {
  try { const protocol = new URL(url).protocol; return protocol === "http:" || protocol === "https:"; } catch { return false; }
}
export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) throw new Error(t("coreOpenUrl.onlyHttpSLinksCanBeOpened"));
  const open = (host as { openExternalUrl?: Opener }).openExternalUrl;
  if (typeof open === "function") return open(url);
  await Linking.openURL(url);
}
