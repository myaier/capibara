import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSourceKind, proseImageUrls } from "../shared/prose";
import { RESULT_IMAGE_MAX_BYTES, RESULT_IMAGE_PART_BYTES, type ResultImagePart, type ResultImageRequest } from "../shared/result-image";
import { contentRevision } from "./revision";

function imageMime(header: Buffer): ResultImagePart["mime"] | null {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))) return "image/gif";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (header.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(header.toString("ascii", 8, 12))) return "image/avif";
  return null;
}

/** Only server-verified image references from this agent's reply can read files on this daemon. */
export async function readResultImagePart(input: ResultImageRequest, reply: string | readonly string[], cwd: string | null): Promise<ResultImagePart> {
  const urls = typeof reply === "string" ? proseImageUrls(reply) : reply;
  if (imageSourceKind(input.url) !== "local" || !urls.includes(input.url)) throw new Error("Image is not referenced by this reply");
  const fileUrl = /^file:/i.test(input.url) ? new URL(input.url) : null;
  if (fileUrl?.hostname && fileUrl.hostname !== "localhost") throw new Error("Image must be on this host");
  const path = fileUrl ? fileURLToPath(fileUrl) : decodeURIComponent(input.url);
  if (/^[/\\]{2}/.test(path)) throw new Error("Network image paths are not supported");
  if (!isAbsolute(path) && !cwd) throw new Error("Image has no working directory");
  const file = await open(isAbsolute(path) ? path : resolve(cwd!, path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > RESULT_IMAGE_MAX_BYTES) throw new Error("Image is empty, too large, or not a regular file");
    const versionOf = (value: typeof stat) => contentRevision([value.ino, value.size, value.mtimeMs, value.ctimeMs]);
    const version = versionOf(stat), parts = Math.ceil(stat.size / RESULT_IMAGE_PART_BYTES);
    if (!Number.isInteger(input.part) || input.part < 0 || input.part >= parts || (input.part > 0 && input.version !== version) || (input.version && input.version !== version)) throw new Error("Image changed or part is invalid");
    const header = Buffer.alloc(32);
    await file.read(header, 0, header.length, 0);
    const mime = imageMime(header);
    if (!mime) throw new Error("Unsupported image format");
    const offset = input.part * RESULT_IMAGE_PART_BYTES, buffer = Buffer.alloc(Math.min(RESULT_IMAGE_PART_BYTES, stat.size - offset));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, offset + bytes);
      if (!result.bytesRead) throw new Error("Image changed while reading");
      bytes += result.bytesRead;
    }
    if (versionOf(await file.stat()) !== version) throw new Error("Image changed while reading");
    return { mime, data: buffer.toString("base64"), part: input.part, parts, version };
  } finally { await file.close(); }
}
