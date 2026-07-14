/** Stable, wire-safe identifier derived from durable Mission coordinates. */
export function safeId(value: string, prefix: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 70) || "item";
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${slug}-${(hash >>> 0).toString(36)}`;
}
