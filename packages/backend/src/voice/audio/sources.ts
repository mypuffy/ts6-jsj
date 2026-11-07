import { spawn } from 'child_process';
import axios from 'axios';
import { getCookieArgs } from './youtube.js';

/**
 * Multi-source resolver for the music bot.
 *
 * Everything that is not a local file goes through yt-dlp, which gives us
 * YouTube, YouTube Music, SoundCloud (tracks, sets, likes, profiles, search,
 * "recommended"), Bandcamp, Mixcloud and hundreds of other sites for free.
 *
 * Spotify links are DRM-protected, so they are resolved to "Artist - Title"
 * and searched on the preferred provider instead.
 */

export type TrackSource = 'youtube' | 'soundcloud' | 'url' | 'local' | 'radio';
export type SearchProvider = 'youtube' | 'soundcloud';

export interface TrackInfo {
  /** Stable key, e.g. "yt_dQw4w9WgXcQ" or "sc_123456" */
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds, 0 = unknown
  thumbnail: string;
  /** Canonical page URL that yt-dlp can resolve again later */
  url: string;
  source: TrackSource;
}

export interface ResolvedStream {
  url: string;
  headers: Record<string, string>;
  isLive: boolean;
  info: TrackInfo;
  resolvedAt: number;
}

export interface ResolveResult {
  type: 'track' | 'playlist';
  title?: string;
  items: TrackInfo[];
}

const YTDLP_TIMEOUT_MS = 45_000;
const MAX_PLAYLIST_ITEMS = 250;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export function detectSource(input: string): TrackSource | 'spotify' | 'search' {
  const s = input.trim();
  if (!isUrl(s)) return 'search';
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch { return 'search'; }
  if (/(^|\.)soundcloud\.com$/.test(host) || host === 'snd.sc' || host === 'on.soundcloud.com') return 'soundcloud';
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be' || /(^|\.)youtube-nocookie\.com$/.test(host)) return 'youtube';
  if (host === 'open.spotify.com' || host === 'spotify.link') return 'spotify';
  return 'url';
}

function sourceFromExtractor(extractor: string | undefined, url: string): TrackSource {
  const e = (extractor || '').toLowerCase();
  if (e.includes('soundcloud')) return 'soundcloud';
  if (e.includes('youtube')) return 'youtube';
  const d = detectSource(url);
  return d === 'spotify' || d === 'search' ? 'url' : d;
}

function pickThumb(e: any): string {
  if (typeof e.thumbnail === 'string' && e.thumbnail) return e.thumbnail;
  const thumbs: any[] = Array.isArray(e.thumbnails) ? e.thumbnails : [];
  if (thumbs.length === 0) return '';
  // Prefer a medium sized thumbnail (SoundCloud "t300x300", YouTube "mqdefault")
  const sized = thumbs.filter((t) => t?.url && (t.width ?? 0) >= 200 && (t.width ?? 0) <= 640);
  return (sized[sized.length - 1] || thumbs[thumbs.length - 1])?.url || '';
}

/** Turn a "soundcloud.com/artist/some-track-name" URL into a readable fallback title */
function titleFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || url;
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || url;
  } catch {
    return url;
  }
}

function artistFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? decodeURIComponent(parts[0]).replace(/[-_]+/g, ' ') : '';
  } catch {
    return '';
  }
}

export function entryToTrack(e: any, fallbackSource?: TrackSource): TrackInfo {
  const pageUrl: string = e.webpage_url || e.original_url || e.url || '';
  const source = fallbackSource && fallbackSource !== 'url'
    ? fallbackSource
    : sourceFromExtractor(e.extractor_key || e.ie_key || e.extractor, pageUrl);
  const prefix = source === 'soundcloud' ? 'sc' : source === 'youtube' ? 'yt' : 'url';
  const rawId = String(e.id ?? pageUrl);
  // YouTube flat entries only carry the id – rebuild a playable URL
  const url = source === 'youtube' && rawId && !/^https?:/.test(pageUrl)
    ? `https://www.youtube.com/watch?v=${rawId}`
    : pageUrl;
  const title = e.track || e.title || titleFromUrl(url);
  const artist = e.artist || e.creator || e.uploader || e.channel || artistFromUrl(url) || '';
  let thumbnail = pickThumb(e);
  if (!thumbnail && source === 'youtube' && rawId) thumbnail = `https://i.ytimg.com/vi/${rawId}/mqdefault.jpg`;
  return {
    id: `${prefix}_${rawId}`.slice(0, 120),
    title: String(title),
    artist: String(artist),
    duration: Number(e.duration) || 0,
    thumbnail,
    url,
    source,
  };
}

/** Run yt-dlp and collect stdout. Rejects on non-zero exit or timeout. */
export function runYtDlp(args: string[], timeoutMs = YTDLP_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [...getCookieArgs(), '--no-warnings', ...args], { shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { }
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`yt-dlp not found: ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const line = err.split('\n').find((l) => l.includes('ERROR')) || err;
        return reject(new Error(line.replace(/^ERROR:\s*/, '').trim().slice(0, 300) || `yt-dlp exited with ${code}`));
      }
      resolve(out);
    });
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

export async function searchTracks(query: string, provider: SearchProvider = 'youtube', limit = 10): Promise<TrackInfo[]> {
  const n = Math.max(1, Math.min(25, limit));
  const prefix = provider === 'soundcloud' ? `scsearch${n}:` : `ytsearch${n}:`;
  const out = await runYtDlp(['--flat-playlist', '--dump-json', `${prefix}${query}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return entryToTrack(JSON.parse(line), provider); } catch { return null; }
    })
    .filter((t): t is TrackInfo => !!t && !!t.url);
}

// ─── URL resolution (tracks, playlists, sets) ───────────────────────────────

/**
 * Resolve a URL to one or more tracks without downloading anything.
 * `allowMixes` keeps playlist context for "watch?v=..&list=.." URLs (used by autoplay).
 */
export async function resolveUrl(url: string, opts: { allowMixes?: boolean; limit?: number } = {}): Promise<ResolveResult> {
  const kind = detectSource(url);
  if (kind === 'spotify') {
    const q = await spotifyToQuery(url);
    const results = await searchTracks(q, 'youtube', 1);
    return { type: 'track', items: results.slice(0, 1) };
  }

  const args = ['--flat-playlist', '-J', '--playlist-end', String(opts.limit ?? MAX_PLAYLIST_ITEMS)];
  if (!opts.allowMixes) args.push('--no-playlist');
  args.push(url);

  const out = await runYtDlp(args);
  const data = JSON.parse(out);
  const fallback = kind === 'search' ? undefined : kind;

  if (data._type === 'playlist' && Array.isArray(data.entries)) {
    const items = data.entries
      .filter((e: any) => e && (e.url || e.webpage_url || e.id))
      .map((e: any) => entryToTrack(e, fallback));
    return { type: 'playlist', title: data.title, items };
  }
  return { type: 'track', items: [entryToTrack(data, fallback)] };
}

/**
 * Resolve a single track URL to a direct audio stream URL + headers for FFmpeg.
 * SoundCloud usually returns an HLS (m3u8) URL, YouTube a googlevideo URL.
 */
export async function resolveStream(url: string): Promise<ResolvedStream> {
  const isSoundCloud = detectSource(url) === 'soundcloud';
  const out = await runYtDlp([
    '-j',
    '--no-playlist',
    // YouTube: Opus ~160 kbps is best. SoundCloud: prefer the 128 kbps MP3/AAC over the 64 kbps Opus preview.
    '-f', isSoundCloud ? 'bestaudio/best' : 'bestaudio[acodec=opus]/bestaudio/best',
    ...(isSoundCloud ? ['-S', 'abr'] : []),
    url,
  ]);
  const data = JSON.parse(out);
  const direct: string | undefined = data.url || data.requested_formats?.[0]?.url;
  if (!direct) throw new Error('No playable audio stream found');
  const headers: Record<string, string> = {};
  const h = data.http_headers || data.requested_formats?.[0]?.http_headers || {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') headers[k] = v;
  }
  return {
    url: direct,
    headers,
    isLive: !!data.is_live,
    info: entryToTrack(data),
    resolvedAt: Date.now(),
  };
}

// ─── Autoplay / related ─────────────────────────────────────────────────────

/** Find tracks related to the given one (YouTube Mix / SoundCloud "recommended"). */
export async function findRelated(track: { url?: string; title: string; artist?: string; source: string }, provider: SearchProvider): Promise<TrackInfo[]> {
  try {
    if (track.source === 'soundcloud' && track.url && /soundcloud\.com\/[^/]+\/[^/?#]+/.test(track.url)) {
      const base = track.url.split(/[?#]/)[0].replace(/\/$/, '');
      const res = await resolveUrl(`${base}/recommended`, { allowMixes: true, limit: 25 });
      if (res.items.length) return res.items;
    }
    if (track.source === 'youtube' && track.url) {
      const m = track.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
      if (m) {
        const res = await resolveUrl(`https://www.youtube.com/watch?v=${m[1]}&list=RD${m[1]}`, { allowMixes: true, limit: 25 });
        if (res.items.length) return res.items;
      }
    }
  } catch { /* fall through to search */ }

  const q = track.artist ? `${track.artist}` : track.title;
  return searchTracks(q, provider, 10);
}

// ─── Spotify (metadata only) ────────────────────────────────────────────────

async function spotifyToQuery(url: string): Promise<string> {
  const res = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 3,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TS6Manager/1.0)' },
  });
  const html = String(res.data);
  const meta = (prop: string) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'))?.[1] ?? '';
  const title = decodeHtml(meta('og:title'));
  // og:description looks like "Artist · Album · Song · 2021"
  const artist = decodeHtml(meta('og:description').split('·')[0] || '').trim();
  if (!title) throw new Error('Could not read Spotify track info');
  return artist ? `${artist} - ${title}` : title;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatDuration(sec: number | undefined | null): string {
  if (!sec || sec <= 0 || !isFinite(sec)) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Parse "90", "1:30" or "1:02:03" into seconds */
export function parseTimestamp(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
