import { deflateSync, inflateSync } from "node:zlib";

/**
 * A minimal PNG codec for the Node-hosted vision evaluations.
 *
 * The face dataset has to be readable without a browser: the detector is scored under
 * vitest so the numbers come out of CI rather than out of someone's laptop. Node has no
 * image decoding, and pulling in a decoder to read five committed test images would add a
 * dependency to the extension's tree that ships nowhere and is trusted for pixel data.
 * Non-interlaced 8-bit RGB/RGBA is all the dataset uses, and it is ~80 lines.
 *
 * `encodeRgbaPng` exists so a failing evaluation can write out what it actually saw, with
 * the boxes drawn on - a recall number alone does not tell you *which* face was missed.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buffer: Buffer): RgbaImage {
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[index] !== byte) throw new Error("Not a PNG file");
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}`);
      if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`Unsupported PNG colour type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    unfilter(filter, source, line, previous, channels);

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      data[to] = line[from]!;
      data[to + 1] = line[from + 1]!;
      data[to + 2] = line[from + 2]!;
      data[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    previous.set(line);
  }

  return { width, height, data };
}

/** PNG's five per-scanline filters, reversed in place. */
function unfilter(
  filter: number,
  source: Uint8Array,
  line: Uint8Array,
  previous: Uint8Array,
  channels: number,
): void {
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i]!;
    const left = i >= channels ? line[i - channels]! : 0;
    const up = previous[i]!;
    const upLeft = i >= channels ? previous[i - channels]! : 0;
    switch (filter) {
      case 0:
        line[i] = raw;
        break;
      case 1:
        line[i] = (raw + left) & 0xff;
        break;
      case 2:
        line[i] = (raw + up) & 0xff;
        break;
      case 3:
        line[i] = (raw + ((left + up) >> 1)) & 0xff;
        break;
      case 4:
        line[i] = (raw + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unknown PNG filter ${filter}`);
    }
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function encodeRgbaPng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(image.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
