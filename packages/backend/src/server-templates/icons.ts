import zlib from 'zlib';

/**
 * Built-in 16×16 pixel icons for server groups and channels.
 * Drawn as masks:  '.' transparent · '#' main colour · 'o' outline (darker) · 'w' highlight.
 * Rendered to PNG at runtime – no binary assets in the repo.
 */

export interface IconDef {
  label: string;
  color: string; // hex
  mask: string[];
}

export const ICONS: Record<string, IconDef> = {
  crown: {
    label: 'Crown', color: '#f5b301', mask: [
      '................',
      '................',
      '..o....oo....o..',
      '.o#o..o##o..o#o.',
      '.o##o.o##o.o##o.',
      '.o###o####o###o.',
      '.o############o.',
      '.o############o.',
      '.o##w##w##w###o.',
      '.o############o.',
      '..oooooooooooo..',
      '..o##########o..',
      '..oooooooooooo..',
      '................',
      '................',
      '................',
    ],
  },
  shield: {
    label: 'Shield', color: '#3b82f6', mask: [
      '................',
      '...oooooooooo...',
      '..o##########o..',
      '..o#ww#######o..',
      '..o#w########o..',
      '..o##########o..',
      '..o##########o..',
      '..o##########o..',
      '...o########o...',
      '...o########o...',
      '....o######o....',
      '.....o####o.....',
      '......o##o......',
      '.......oo.......',
      '................',
      '................',
    ],
  },
  star: {
    label: 'Star', color: '#facc15', mask: [
      '................',
      '.......oo.......',
      '......o##o......',
      '......o##o......',
      '.....o#ww#o.....',
      'oooooo####oooooo',
      '.o############o.',
      '..o##########o..',
      '...o########o...',
      '....o######o....',
      '....o##oo##o....',
      '...o##o..o##o...',
      '...o#o....o#o...',
      '..o#o......o#o..',
      '..oo........oo..',
      '................',
    ],
  },
  note: {
    label: 'Music note', color: '#ff6a1a', mask: [
      '................',
      '........oo......',
      '........o#o.....',
      '........o##o....',
      '........o#o#o...',
      '........o#o.#o..',
      '........o#o..o..',
      '........o#o.....',
      '........o#o.....',
      '....ooooo#o.....',
      '...o######o.....',
      '..o##ww###o.....',
      '..o######o......',
      '...o####o.......',
      '....oooo........',
      '................',
    ],
  },
  robot: {
    label: 'Robot', color: '#94a3b8', mask: [
      '................',
      '.......oo.......',
      '.......oo.......',
      '...oooooooooo...',
      '..o##########o..',
      '..o#ww####ww#o..',
      '..o#ww####ww#o..',
      '..o##########o..',
      '..o###oooo###o..',
      '..o##########o..',
      '...oooooooooo...',
      '....o######o....',
      '..oo########oo..',
      '..o#o######o#o..',
      '..oo.oooooo.oo..',
      '................',
    ],
  },
  user: {
    label: 'User', color: '#22c55e', mask: [
      '................',
      '......oooo......',
      '.....o####o.....',
      '....o#w####o....',
      '....o######o....',
      '....o######o....',
      '.....o####o.....',
      '......oooo......',
      '....oooooooo....',
      '...o########o...',
      '..o##########o..',
      '..o##########o..',
      '..o##########o..',
      '..oooooooooooo..',
      '................',
      '................',
    ],
  },
  headphones: {
    label: 'Headphones', color: '#a855f7', mask: [
      '................',
      '.....oooooo.....',
      '...oo######oo...',
      '..o##oooooo##o..',
      '.o#oo......oo#o.',
      '.o#o........o#o.',
      '.o#o........o#o.',
      'oooo........oooo',
      'o##o........o##o',
      'o#wo........o#wo',
      'o##o........o##o',
      'o##o........o##o',
      'oooo........oooo',
      '................',
      '................',
      '................',
    ],
  },
  gamepad: {
    label: 'Gamepad', color: '#ef4444', mask: [
      '................',
      '................',
      '................',
      '...oooooooooo...',
      '..o##########o..',
      '.o##o####ww###o.',
      '.o#ooo##w##w##o.',
      '.o##o####ww###o.',
      '.o############o.',
      '.o####oooo####o.',
      '.o###o....o###o.',
      '..ooo......ooo..',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  afk: {
    label: 'AFK (Zzz)', color: '#64748b', mask: [
      '................',
      '........oooooo..',
      '........o####o..',
      '...........o#o..',
      '..........o#o...',
      '.........o#o....',
      '........o####o..',
      '........oooooo..',
      '..ooooo.........',
      '..o###o.........',
      '....o#o.........',
      '...o#o..........',
      '..o###o.........',
      '..ooooo.........',
      '................',
      '................',
    ],
  },
  lock: {
    label: 'Lock', color: '#eab308', mask: [
      '................',
      '.....oooooo.....',
      '....o######o....',
      '...o##oooo##o...',
      '...o#o....o#o...',
      '...o#o....o#o...',
      '..oooooooooooo..',
      '..o##########o..',
      '..o#####oo###o..',
      '..o####o##o##o..',
      '..o#####oo###o..',
      '..o#####oo###o..',
      '..o##########o..',
      '..oooooooooooo..',
      '................',
      '................',
    ],
  },
  info: {
    label: 'Info', color: '#0ea5e9', mask: [
      '................',
      '.....oooooo.....',
      '...oo######oo...',
      '..o####ww####o..',
      '..o####ww####o..',
      '.o############o.',
      '.o####www#####o.',
      '.o#####ww#####o.',
      '.o#####ww#####o.',
      '.o#####ww#####o.',
      '..o###wwww###o..',
      '..o##########o..',
      '...oo######oo...',
      '.....oooooo.....',
      '................',
      '................',
    ],
  },
  support: {
    label: 'Support (?)', color: '#14b8a6', mask: [
      '................',
      '.....oooooo.....',
      '...oo######oo...',
      '..o###wwww###o..',
      '..o##ww##ww##o..',
      '.o#######ww###o.',
      '.o######ww####o.',
      '.o#####ww#####o.',
      '.o#####ww#####o.',
      '.o############o.',
      '..o####ww####o..',
      '..o####ww####o..',
      '...oo######oo...',
      '.....oooooo.....',
      '................',
      '................',
    ],
  },
  heart: {
    label: 'Heart', color: '#ec4899', mask: [
      '................',
      '................',
      '..oooo....oooo..',
      '.o####o..o####o.',
      'o##ww##oo######o',
      'o#ww###########o',
      'o##############o',
      'o##############o',
      '.o############o.',
      '..o##########o..',
      '...o########o...',
      '....o######o....',
      '.....o####o.....',
      '......o##o......',
      '.......oo.......',
      '................',
    ],
  },
  mic: {
    label: 'Microphone', color: '#f43f5e', mask: [
      '................',
      '......oooo......',
      '.....o####o.....',
      '.....o#ww#o.....',
      '.....o#w##o.....',
      '.....o####o.....',
      '.....o####o.....',
      '...o.o####o.o...',
      '...o..oooo..o...',
      '....o......o....',
      '.....oooooo.....',
      '.......oo.......',
      '.......oo.......',
      '.....oooooo.....',
      '................',
      '................',
    ],
  },
};

// ─── PNG encoding ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function encodePng(width: number, height: number, rgba: Buffer, extraText?: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (extraText) parts.push(chunk('tEXt', Buffer.from(`Comment\0${extraText}`, 'latin1')));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

export function renderIcon(key: string, colorOverride?: string): Buffer {
  const def = ICONS[key];
  if (!def) throw new Error(`Unknown icon "${key}"`);
  const [r, g, b] = hexToRgb(colorOverride || def.color);
  const dark: [number, number, number] = [Math.round(r * 0.45), Math.round(g * 0.45), Math.round(b * 0.45)];
  const light: [number, number, number] = [Math.min(255, r + (255 - r) * 0.75), Math.min(255, g + (255 - g) * 0.75), Math.min(255, b + (255 - b) * 0.75)].map(Math.round) as any;
  const rgba = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    const row = def.mask[y] ?? '';
    for (let x = 0; x < 16; x++) {
      const ch = row[x] ?? '.';
      const i = (y * 16 + x) * 4;
      const px = ch === '#' ? [r, g, b] : ch === 'o' ? dark : ch === 'w' ? light : null;
      if (!px) continue;
      rgba[i] = px[0]; rgba[i + 1] = px[1]; rgba[i + 2] = px[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(16, 16, rgba);
}

export interface PreparedIcon {
  key: string;
  png: Buffer;
  /** TeamSpeak icon id (= CRC32 of the file). Always < 2^31 so signed/unsigned are identical. */
  id: number;
}

/**
 * TeamSpeak identifies icons by the CRC32 of the file. Permission values are signed
 * 32-bit, so we nudge the file (comment chunk) until the CRC is below 2^31 – that way
 * the id is the same no matter how a client interprets it.
 */
export function prepareIcon(key: string, colorOverride?: string): PreparedIcon {
  const base = renderIcon(key, colorOverride);
  let png = base;
  let id = crc32(png);
  for (let n = 0; id >= 0x80000000 && n < 1000; n++) {
    png = withComment(base, `ts6-jsj ${key} ${n}`);
    id = crc32(png);
  }
  return { key, png, id };
}

function withComment(png: Buffer, text: string): Buffer {
  // Insert tEXt chunk after IHDR (8 byte signature + 25 byte IHDR chunk)
  const head = png.subarray(0, 33);
  const rest = png.subarray(33);
  return Buffer.concat([head, chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1')), rest]);
}

/** Data URLs for previews in the web UI */
export function iconDataUrls(): Record<string, { label: string; dataUrl: string }> {
  const out: Record<string, { label: string; dataUrl: string }> = {};
  for (const [key, def] of Object.entries(ICONS)) {
    out[key] = { label: def.label, dataUrl: `data:image/png;base64,${renderIcon(key).toString('base64')}` };
  }
  return out;
}

/** Validate a user-supplied PNG icon (≤ 64 KB, PNG signature) */
export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.length < 64 * 1024 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
