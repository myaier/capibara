import { createHash } from "node:crypto";

/** Every change to the serialized value changes the revision; identical content keeps it across plugin reloads. */
export function contentRevision(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value) ?? "null").digest("base64url").slice(0, 22);
}
