import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { t } from "./text";

// Base64 fits below the host's 128 KiB RPC limit; multiples of three concatenate without intermediate padding.
export const RESULT_IMAGE_PART_BYTES = 72 * 1024;
export const RESULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const getResultImage = defineRpc({
  name: "observatory.results.image",
  input: z.object({ agentId: z.string().min(1).max(256), url: z.string().min(1).max(4096), part: z.number().int().min(0).max(113), version: z.string().max(80).optional(), replyRef: z.string().min(1).max(1024).optional() }),
  output: z.object({ mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]),
    data: z.string().max(RESULT_IMAGE_PART_BYTES / 3 * 4), part: z.number().int().nonnegative(), parts: z.number().int().min(1).max(114), version: z.string().max(80) }),
});
export type ResultImageRequest = z.infer<typeof getResultImage.input>;
export type ResultImagePart = z.infer<typeof getResultImage.output>;

/** Keep one version throughout a read, including when the file changes while parts are in flight. */
export async function loadResultImage(read: (input: ResultImageRequest) => Promise<ResultImagePart>, agentId: string, url: string, cancelled = () => false, replyRef?: string): Promise<string> {
  const source = replyRef ? { replyRef } : {};
  const first = await read({ agentId, url, part: 0, ...source });
  if (first.part !== 0) throw new Error("Unexpected image part");
  const parts = [first.data];
  let next = 1;
  await Promise.all(Array.from({ length: Math.min(3, first.parts - 1) }, async () => {
    while (next < first.parts && !cancelled()) {
      const part = next++, response = await read({ agentId, url, part, version: first.version, ...source });
      if (response.version !== first.version || response.mime !== first.mime || response.parts !== first.parts || response.part !== part) throw new Error("Image changed while loading");
      parts[part] = response.data;
    }
  }));
  if (cancelled()) throw new Error("Image read cancelled");
  return `data:${first.mime};base64,${parts.join("")}`;
}

/** Show an actionable reason without exposing a raw host stack trace. */
export function resultImageFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|ENOTDIR|no such file/i.test(message)) return t("secondaryResultView.imageFileMissing");
  if (/EACCES|EPERM|permission denied/i.test(message)) return t("secondaryResultView.imagePermissionDenied");
  if (/reply.*(?:expired|unavailable)|not referenced/i.test(message)) return t("secondaryResultView.imageReplyExpired");
  if (/Image changed/i.test(message)) return t("secondaryResultView.imageChanged");
  if (/Unsupported image|too large|not a regular file|empty/i.test(message)) return t("secondaryResultView.imageUnsupported");
  return null;
}
