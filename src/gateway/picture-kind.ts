// What kind of picture a file's first bytes say it is (Stage 8.4), on its own so both upload paths (the apps' and a
// Shortcut's, Stage 14.3) can use it without pulling in the PC's routes.
export function pictureKind(head: Buffer): "jpg" | "png" | "webp" | "heic" | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(head.subarray(8, 12).toString("latin1"))) return "heic";
  return null;
}
