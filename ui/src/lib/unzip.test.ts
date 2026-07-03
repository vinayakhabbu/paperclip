import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readZip } from "./unzip";

// Build a minimal valid zip: local headers + central directory + EOCD.
function makeZip(entries: Array<{ path: string; content: string; deflate?: boolean }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const uncompressed = encoder.encode(entry.content);
    const data = entry.deflate ? new Uint8Array(deflateRawSync(uncompressed)) : uncompressed;
    const method = entry.deflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, uncompressed.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, uncompressed.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);

    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, localOffset, true);

  const out = new Uint8Array(localOffset + centralSize + 22);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

describe("readZip", () => {
  it("reads stored and deflated entries, skipping directory markers", async () => {
    const zip = makeZip([
      { path: "my-skill/SKILL.md", content: "---\nname: my-skill\n---\n# Hi" },
      { path: "my-skill/", content: "" },
      { path: "my-skill/references/notes.md", content: "some reference text", deflate: true },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(["my-skill/SKILL.md", "my-skill/references/notes.md"]);
    expect(new TextDecoder().decode(entries[0].data)).toContain("name: my-skill");
    expect(new TextDecoder().decode(entries[1].data)).toBe("some reference text");
  });

  it("rejects non-zip data", async () => {
    await expect(readZip(new TextEncoder().encode("not a zip at all").buffer as ArrayBuffer)).rejects.toThrow(/Not a zip/);
  });
});
