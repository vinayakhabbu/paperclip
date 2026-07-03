// Minimal zip reader for skill archives: walks the central directory and
// inflates entries with the browser-native DecompressionStream — no library.
// Sizes come from the central directory, so data-descriptor entries (general
// purpose bit 3) work. CRCs are not verified.
// ponytail: no zip64, encrypted, or multi-disk archives — those throw.

export type ZipEntry = { path: string; data: Uint8Array };

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // The end-of-central-directory record is in the last 22..22+65535 bytes
  // (trailing archive comment can be up to 64 KiB).
  let eocd = -1;
  const searchFloor = Math.max(0, buffer.byteLength - 22 - 65535);
  for (let i = buffer.byteLength - 22; i >= searchFloor; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("zip64 archives are not supported");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) throw new Error("Corrupt zip central directory");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith("/")) continue; // directory marker
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted zip entries are not supported (${path})`);

    // Name/extra lengths in the local header can differ from the central copy.
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localName + localExtra;
    const raw = bytes.slice(dataStart, dataStart + compressedSize);

    if (method === 0) entries.push({ path, data: raw });
    else if (method === 8) entries.push({ path, data: await inflateRaw(raw) });
    else throw new Error(`Unsupported zip compression method ${method} (${path})`);
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
