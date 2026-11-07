import type { PrismaClient } from '../../generated/prisma/index.js';
import type { QueueItem } from './playlist/queue.js';
import type { VoiceBot } from './voice-bot.js';
import {
  detectSource, isUrl, resolveUrl, searchTracks,
  type SearchProvider, type TrackInfo,
} from './audio/sources.js';

/**
 * Shared music logic used by the REST API, the in-channel chat commands and the
 * flow engine – so "!play", the web UI and a flow node all behave identically.
 */

export type EnqueueMode = 'now' | 'next' | 'queue';

export function trackToQueueItem(t: TrackInfo, requestedBy?: string): QueueItem {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist || undefined,
    duration: t.duration || undefined,
    thumbnail: t.thumbnail || undefined,
    filePath: '',
    source: t.source === 'local' || t.source === 'radio' ? 'url' : t.source,
    sourceUrl: t.url,
    requestedBy,
  };
}

export function songToQueueItem(song: any, requestedBy?: string): QueueItem {
  return {
    id: String(song.id),
    title: song.title,
    artist: song.artist ?? undefined,
    duration: song.duration ?? undefined,
    filePath: song.filePath,
    source: (song.source as QueueItem['source']) || 'local',
    sourceUrl: song.sourceUrl ?? undefined,
    requestedBy,
  };
}

export function stationToQueueItem(station: any, requestedBy?: string): QueueItem {
  return {
    id: `radio_${station.id}`,
    title: station.name,
    artist: station.genre ?? 'Radio',
    filePath: '',
    source: 'radio',
    streamUrl: station.url,
    thumbnail: station.imageUrl ?? undefined,
    requestedBy,
  };
}

export interface ResolvedInput {
  items: QueueItem[];
  playlistTitle?: string;
  /** true when the input was a free-text search */
  fromSearch: boolean;
}

/**
 * Turn whatever the user typed into queue items:
 *  - YouTube / SoundCloud / Bandcamp / Mixcloud / direct URL (tracks, playlists, sets)
 *  - Spotify track link (searched on the provider)
 *  - free text (first search hit on the given provider)
 */
export async function resolveInput(input: string, opts: { provider?: SearchProvider; requestedBy?: string } = {}): Promise<ResolvedInput> {
  const text = input.trim();
  if (!text) throw new Error('Nothing to play');

  if (!isUrl(text)) {
    const results = await searchTracks(text, opts.provider ?? 'youtube', 1);
    if (results.length === 0) throw new Error(`No results for "${text}"`);
    return { items: [trackToQueueItem(results[0], opts.requestedBy)], fromSearch: true };
  }

  const kind = detectSource(text);
  // Direct audio file URLs (mp3/ogg/...) – no yt-dlp needed
  if (kind === 'url' && /\.(mp3|ogg|opus|flac|wav|m4a|aac)(\?|$)/i.test(text)) {
    const name = decodeURIComponent(text.split(/[?#]/)[0].split('/').pop() || text);
    return {
      items: [{ id: `url_${text}`.slice(0, 120), title: name, filePath: '', source: 'url', sourceUrl: undefined, streamUrl: text, requestedBy: opts.requestedBy }],
      fromSearch: false,
    };
  }

  const res = await resolveUrl(text);
  if (res.items.length === 0) throw new Error('Nothing playable found at that URL');
  return {
    items: res.items.map((t) => trackToQueueItem(t, opts.requestedBy)),
    playlistTitle: res.type === 'playlist' ? res.title : undefined,
    fromSearch: false,
  };
}

/**
 * Put items into a bot's queue according to `mode` and start playback if needed.
 * Returns the display position of the first item and whether playback started.
 */
export async function enqueueItems(bot: VoiceBot, items: QueueItem[], mode: EnqueueMode = 'queue'): Promise<{ position: number; started: boolean }> {
  if (items.length === 0) return { position: -1, started: false };
  const idle = bot.status !== 'playing' && bot.status !== 'paused';

  if (mode === 'now' || idle) {
    // Insert right after the current track (keeps playlist order) and jump there
    const pos = bot.queue.insertManyNext(items);
    const item = bot.queue.playAt(pos)!;
    await bot.play(item);
    return { position: pos, started: true };
  }

  if (mode === 'next') {
    return { position: bot.queue.insertManyNext(items), started: false };
  }

  let first = -1;
  for (const it of items) {
    const p = bot.queue.add(it);
    if (first < 0) first = p;
  }
  return { position: first, started: false };
}

/** Record a request in the MusicRequest history (deduplicated per server + URL). */
export function saveMusicRequest(prisma: PrismaClient, serverConfigId: number | undefined, item: QueueItem): void {
  const url = item.sourceUrl || item.streamUrl;
  if (!url || !serverConfigId || item.source === 'radio') return;
  (prisma as any).musicRequest.upsert({
    where: { serverConfigId_url: { serverConfigId, url } },
    update: {
      requestedAt: new Date(),
      title: item.title || 'Unknown Title',
      artist: item.artist ?? null,
      source: item.source,
      requestedBy: item.requestedBy ?? null,
      playCount: { increment: 1 },
    },
    create: {
      serverConfigId,
      url,
      title: item.title || 'Unknown Title',
      artist: item.artist ?? null,
      source: item.source,
      requestedBy: item.requestedBy ?? null,
      requestedAt: new Date(),
    },
  }).catch((err: any) => {
    console.error('[Music] Failed to save music request history:', err.message);
  });
}
