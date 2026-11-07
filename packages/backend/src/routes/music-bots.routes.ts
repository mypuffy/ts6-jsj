import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { playerWidgetToken } from './widget-public.routes.js';
import { publicItem } from '../voice/playlist/queue.js';
import {
  resolveInput, enqueueItems, trackToQueueItem, songToQueueItem, stationToQueueItem,
  saveMusicRequest, type EnqueueMode,
} from '../voice/music-service.js';
import { isUrl, type SearchProvider } from '../voice/audio/sources.js';

export const musicBotRoutes: Router = Router();

// All routes require admin role
musicBotRoutes.use(requireRole('admin'));

const SETTINGS_KEYS = ['normalize', 'autoplay', 'announce', 'autoPauseEmpty', 'nowPlayingNick'] as const;

function parseMode(v: any): EnqueueMode {
  return v === 'now' || v === 'next' ? v : 'queue';
}

function parseProvider(v: any): SearchProvider | undefined {
  return v === 'soundcloud' ? 'soundcloud' : v === 'youtube' ? 'youtube' : undefined;
}

function pickSettings(body: any) {
  const out: Record<string, any> = {};
  for (const k of SETTINGS_KEYS) if (typeof body[k] === 'boolean') out[k] = body[k];
  if (typeof body.commandPrefix === 'string' && body.commandPrefix.trim()) out.commandPrefix = body.commandPrefix.trim().slice(0, 3);
  if (body.defaultSearch === 'youtube' || body.defaultSearch === 'soundcloud') out.defaultSearch = body.defaultSearch;
  return out;
}

function getRunningBot(req: Request) {
  const manager: VoiceBotManager = req.app.locals.voiceBotManager;
  const bot = manager.getBot(parseInt(req.params.id as string));
  if (!bot) throw new AppError(404, 'Music bot not found');
  return bot;
}

function requireConnected(bot: ReturnType<typeof getRunningBot>) {
  if (bot.status !== 'connected' && bot.status !== 'playing' && bot.status !== 'paused') {
    throw new AppError(400, 'Bot is not connected');
  }
}

function serializeBot(b: any, runtime: any) {
  return {
    id: b.id,
    name: b.name,
    serverConfigId: b.serverConfigId,
    serverConfig: b.serverConfig,
    nickname: b.nickname,
    defaultChannel: b.defaultChannel,
    voicePort: b.voicePort,
    volume: b.volume,
    autoStart: b.autoStart,
    normalize: b.normalize ?? true,
    autoplay: b.autoplay ?? false,
    announce: b.announce ?? true,
    autoPauseEmpty: b.autoPauseEmpty ?? true,
    nowPlayingNick: b.nowPlayingNick ?? true,
    commandPrefix: b.commandPrefix ?? '!',
    defaultSearch: b.defaultSearch ?? 'youtube',
    status: runtime?.status ?? 'stopped',
    nowPlaying: runtime?.nowPlaying ?? null,
    listeners: runtime?.listeners ?? 0,
    channelName: runtime?.channelName ?? '',
    queueLength: runtime?.queueLength ?? 0,
    createdAt: b.createdAt,
  };
}

// GET / — List all music bots
musicBotRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const dbBots = await prisma.musicBot.findMany({
      include: { serverConfig: { select: { id: true, name: true, host: true } } },
      orderBy: { id: 'asc' },
    });

    const runtimeMap = new Map(manager.listBots().map((b: any) => [b.id, b]));
    res.json(dbBots.map((b: any) => serializeBot(b, runtimeMap.get(b.id))));
  } catch (err) { next(err); }
});

// GET /:id — Get bot details + runtime status
musicBotRoutes.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const dbBot = await prisma.musicBot.findUnique({
      where: { id },
      include: { serverConfig: { select: { id: true, name: true, host: true } } },
    });
    if (!dbBot) throw new AppError(404, 'Music bot not found');

    const bot = manager.getBot(id);
    res.json({
      ...dbBot,
      identityData: undefined, // don't expose identity
      status: bot?.status ?? 'stopped',
      nowPlaying: publicItem(bot?.nowPlaying),
      playbackProgress: bot?.playbackProgress ?? null,
    });
  } catch (err) { next(err); }
});

// POST / — Create bot
musicBotRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const { name, serverConfigId, nickname, serverPassword, defaultChannel, channelPassword, voicePort, volume, autoStart } = req.body;
    if (!name || !serverConfigId) throw new AppError(400, 'name and serverConfigId are required');

    const result = await manager.createBot({
      name,
      serverConfigId: parseInt(serverConfigId),
      nickname,
      serverPassword,
      defaultChannel,
      channelPassword,
      voicePort: voicePort != null ? parseInt(voicePort) : undefined,
      volume: volume != null ? parseInt(volume) : undefined,
      autoStart: autoStart ?? false,
      ...pickSettings(req.body),
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// PUT /:id — Update bot config
musicBotRoutes.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const { name, nickname, serverPassword, defaultChannel, channelPassword, voicePort, volume, autoStart } = req.body;
    const settings = pickSettings(req.body);

    await prisma.musicBot.update({
      where: { id },
      data: {
        ...(name != null && { name }),
        ...(nickname != null && { nickname }),
        ...(serverPassword !== undefined && { serverPassword }),
        ...(defaultChannel !== undefined && { defaultChannel }),
        ...(channelPassword !== undefined && { channelPassword }),
        ...(voicePort != null && { voicePort: parseInt(voicePort) }),
        ...(volume != null && { volume: parseInt(volume) }),
        ...(autoStart != null && { autoStart }),
        ...settings,
      },
    });

    // Update runtime config if bot is loaded
    const bot = manager.getBot(id);
    if (bot) {
      bot.updateConfig({
        ...(name != null && { name }),
        ...(nickname != null && { nickname }),
        ...(serverPassword !== undefined && { serverPassword: serverPassword || undefined }),
        ...(defaultChannel !== undefined && { defaultChannel: defaultChannel || undefined }),
        ...(channelPassword !== undefined && { channelPassword: channelPassword || undefined }),
        ...(voicePort != null && { serverPort: parseInt(voicePort) }),
        ...(volume != null && { volume: parseInt(volume) }),
        ...settings,
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /:id — Delete bot
musicBotRoutes.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    await manager.removeBot(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/start — Start bot
musicBotRoutes.post('/:id/start', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    await manager.startBot(parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stop — Stop bot
musicBotRoutes.post('/:id/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    await manager.stopBot(parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/restart — Restart bot
musicBotRoutes.post('/:id/restart', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    await bot.restart();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// === Playback Control ===

// POST /:id/play — Play a library song  { songId, mode? }
musicBotRoutes.post('/:id/play', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { songId } = req.body;
    if (!songId) throw new AppError(400, 'songId is required');
    const bot = getRunningBot(req);
    requireConnected(bot);

    const song = await prisma.song.findUnique({ where: { id: parseInt(songId) } });
    if (!song) throw new AppError(404, 'Song not found');

    const result = await enqueueItems(bot, [songToQueueItem(song, req.user?.username)], req.body.mode ? parseMode(req.body.mode) : 'now');
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

/**
 * POST /:id/play-url — Play/queue anything: YouTube, SoundCloud (tracks/sets/likes),
 * Bandcamp, Mixcloud, Spotify track links, direct audio URLs or free-text search.
 * Body: { url?: string, query?: string, mode?: 'now'|'next'|'queue', provider?: 'youtube'|'soundcloud' }
 */
musicBotRoutes.post('/:id/play-url', async (req: Request, res: Response, next) => {
  try {
    const input: string = (req.body.url || req.body.query || '').toString();
    if (!input.trim()) throw new AppError(400, 'url or query is required');
    const bot = getRunningBot(req);
    requireConnected(bot);

    const provider = parseProvider(req.body.provider) ?? bot.currentConfig.defaultSearch ?? 'youtube';
    const resolved = await resolveInput(input, { provider, requestedBy: req.user?.username });
    const mode = req.body.mode ? parseMode(req.body.mode) : 'now';
    const result = await enqueueItems(bot, resolved.items, mode);
    for (const it of resolved.items.slice(0, 50)) saveMusicRequest(req.app.locals.prisma, bot.currentConfig.serverConfigId, it);

    res.json({
      success: true,
      ...result,
      count: resolved.items.length,
      playlistTitle: resolved.playlistTitle,
      queueItem: publicItem(resolved.items[0]),
    });
  } catch (err: any) {
    next(err instanceof AppError ? err : new AppError(500, `Failed to play: ${err.message}`));
  }
});

// POST /:id/queue/track — Add a search result directly (no second lookup). Body: { track, mode }
musicBotRoutes.post('/:id/queue/track', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    requireConnected(bot);
    const t = req.body.track;
    if (!t || typeof t.url !== 'string' || !isUrl(t.url)) throw new AppError(400, 'track with url is required');
    const item = trackToQueueItem({
      id: String(t.id || t.url).slice(0, 120),
      title: String(t.title || t.url).slice(0, 300),
      artist: String(t.artist || '').slice(0, 200),
      duration: Number(t.duration) || 0,
      thumbnail: typeof t.thumbnail === 'string' ? t.thumbnail : '',
      url: t.url,
      source: t.source === 'soundcloud' ? 'soundcloud' : t.source === 'youtube' ? 'youtube' : 'url',
    }, req.user?.username);
    const result = await enqueueItems(bot, [item], parseMode(req.body.mode));
    saveMusicRequest(req.app.locals.prisma, bot.currentConfig.serverConfigId, item);
    res.json({ success: true, ...result });
  } catch (err: any) {
    next(err instanceof AppError ? err : new AppError(500, `Failed to queue: ${err.message}`));
  }
});

// POST /:id/play-radio — Play a radio station (streaming)
musicBotRoutes.post('/:id/play-radio', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { stationId } = req.body;
    if (!stationId) throw new AppError(400, 'stationId is required');
    const bot = getRunningBot(req);
    requireConnected(bot);

    const station = await prisma.radioStation.findUnique({ where: { id: parseInt(stationId) } });
    if (!station) throw new AppError(404, 'Radio station not found');

    await enqueueItems(bot, [stationToQueueItem(station, req.user?.username)], 'now');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/pause
musicBotRoutes.post('/:id/pause', async (req: Request, res: Response, next) => {
  try { getRunningBot(req).pause(); res.json({ success: true }); } catch (err) { next(err); }
});

// POST /:id/resume
musicBotRoutes.post('/:id/resume', async (req: Request, res: Response, next) => {
  try { getRunningBot(req).resume(); res.json({ success: true }); } catch (err) { next(err); }
});

// POST /:id/stop-playback
musicBotRoutes.post('/:id/stop-playback', async (req: Request, res: Response, next) => {
  try { getRunningBot(req).stopAudio(); res.json({ success: true }); } catch (err) { next(err); }
});

// POST /:id/skip
musicBotRoutes.post('/:id/skip', async (req: Request, res: Response, next) => {
  try { getRunningBot(req).skip(); res.json({ success: true }); } catch (err) { next(err); }
});

// POST /:id/previous
musicBotRoutes.post('/:id/previous', async (req: Request, res: Response, next) => {
  try { getRunningBot(req).previous(); res.json({ success: true }); } catch (err) { next(err); }
});

// POST /:id/seek
musicBotRoutes.post('/:id/seek', async (req: Request, res: Response, next) => {
  try {
    getRunningBot(req).seek(parseFloat(req.body.seconds) || 0);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/volume
musicBotRoutes.post('/:id/volume', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const id = parseInt(req.params.id as string);
    const vol = Math.max(0, Math.min(100, parseInt(req.body.volume) || 0));

    const bot = manager.getBot(id);
    if (bot) bot.setVolume(vol);
    await prisma.musicBot.update({ where: { id }, data: { volume: vol } });

    res.json({ success: true, volume: vol });
  } catch (err) { next(err); }
});

// POST /:id/autoplay  { enabled }
musicBotRoutes.post('/:id/autoplay', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bot = getRunningBot(req);
    const enabled = !!req.body.enabled;
    bot.setAutoplay(enabled);
    await prisma.musicBot.update({ where: { id: bot.id }, data: { autoplay: enabled } });
    res.json({ success: true, autoplay: enabled });
  } catch (err) { next(err); }
});

// GET /:id/state — Full playback state
musicBotRoutes.get('/:id/state', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    const progress = bot.playbackProgress;
    const cfg = bot.currentConfig;
    const running = bot.status !== 'stopped' && bot.status !== 'error';
    res.json({
      status: bot.status,
      nowPlaying: publicItem(bot.nowPlaying),
      position: progress?.position ?? 0,
      duration: progress?.duration ?? 0,
      volume: cfg.volume,
      queue: bot.queue.getAll().map(publicItem),
      currentIndex: bot.queue.index,
      upcomingCount: bot.queue.upcomingCount,
      shuffle: bot.queue.shuffle,
      repeat: bot.queue.repeat,
      isStreaming: bot.isStreaming,
      loading: bot.loading,
      autoplay: !!cfg.autoplay,
      autoPaused: bot.autoPaused,
      channelId: running ? bot.channelId : 0,
      channelName: running ? bot.channelName : '',
      listeners: running ? bot.channelListeners : [],
      history: bot.history.slice(0, 25),
      lastError: bot.lastError,
      videoStream: bot.videoStreamStatus,
    });
  } catch (err) { next(err); }
});

// GET /:id/history
musicBotRoutes.get('/:id/history', async (req: Request, res: Response, next) => {
  try { res.json(getRunningBot(req).history); } catch (err) { next(err); }
});

// GET /:id/channels — Channels the bot can see (for "move to channel")
musicBotRoutes.get('/:id/channels', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    requireConnected(bot);
    res.json({ current: bot.channelId, channels: bot.getChannels() });
  } catch (err) { next(err); }
});

// POST /:id/move — Move bot to channel { cid, password? }
musicBotRoutes.post('/:id/move', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    requireConnected(bot);
    const cid = parseInt(req.body.cid);
    if (!cid) throw new AppError(400, 'cid is required');
    bot.moveToChannel(cid, req.body.password);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// === Queue ===

// GET /:id/queue
musicBotRoutes.get('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    res.json({
      items: bot.queue.getAll().map(publicItem),
      currentIndex: bot.queue.index,
      shuffle: bot.queue.shuffle,
      repeat: bot.queue.repeat,
    });
  } catch (err) { next(err); }
});

// POST /:id/queue — Enqueue a library song { songId, mode? }
musicBotRoutes.post('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bot = getRunningBot(req);
    const song = await prisma.song.findUnique({ where: { id: parseInt(req.body.songId) } });
    if (!song) throw new AppError(404, 'Song not found');

    const item = songToQueueItem(song, req.user?.username);
    const connected = bot.status === 'connected' || bot.status === 'playing' || bot.status === 'paused';
    if (connected) await enqueueItems(bot, [item], parseMode(req.body.mode));
    else bot.queue.add(item);

    res.json({ success: true, queueLength: bot.queue.length });
  } catch (err) { next(err); }
});

// POST /:id/queue/playlist — Load playlist into queue
musicBotRoutes.post('/:id/queue/playlist', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bot = getRunningBot(req);

    const { playlistId, clearFirst } = req.body;
    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
      include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
    });
    if (!playlist) throw new AppError(404, 'Playlist not found');

    if (clearFirst) {
      bot.stopAudio();
      bot.queue.clear();
    }

    const items = playlist.songs.map((ps: any) => songToQueueItem(ps.song, req.user?.username));
    const connected = bot.status === 'connected' || bot.status === 'playing' || bot.status === 'paused';
    if (connected && items.length) await enqueueItems(bot, items, clearFirst ? 'now' : 'queue');
    else bot.queue.addMany(items);

    res.json({ success: true, queueLength: bot.queue.length });
  } catch (err) { next(err); }
});

// DELETE /:id/queue/:index — Remove from queue (display index)
musicBotRoutes.delete('/:id/queue/:index', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    bot.queue.removeAt(parseInt(req.params.index as string));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /:id/queue — Clear queue (?upcoming=1 keeps history + current)
musicBotRoutes.delete('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    if (req.query.upcoming) bot.queue.clearUpcoming();
    else bot.queue.clear();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/queue/shuffle
musicBotRoutes.post('/:id/queue/shuffle', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    bot.queue.setShuffle(req.body.enabled ?? true);
    res.json({ success: true, shuffle: bot.queue.shuffle });
  } catch (err) { next(err); }
});

// POST /:id/queue/repeat
musicBotRoutes.post('/:id/queue/repeat', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    const mode = req.body.mode ?? 'off';
    if (!['off', 'track', 'queue'].includes(mode)) throw new AppError(400, 'Invalid repeat mode');
    bot.queue.setRepeat(mode);
    res.json({ success: true, repeat: bot.queue.repeat });
  } catch (err) { next(err); }
});

// POST /:id/queue/:index/play — Play track at queue index
musicBotRoutes.post('/:id/queue/:index/play', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    requireConnected(bot);
    const item = bot.queue.playAt(parseInt(req.params.index as string));
    if (!item) throw new AppError(400, 'Invalid queue index');
    await bot.play(item);
    res.json({ success: true, nowPlaying: { title: item.title, artist: item.artist } });
  } catch (err) { next(err); }
});

// PUT /:id/queue/move — Move queue item from one position to another
musicBotRoutes.put('/:id/queue/move', async (req: Request, res: Response, next) => {
  try {
    const bot = getRunningBot(req);
    const { from, to } = req.body;
    if (typeof from !== 'number' || typeof to !== 'number') throw new AppError(400, 'from and to are required');
    if (!bot.queue.move(from, to)) throw new AppError(400, 'Invalid indices');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// === Video Streaming ===

// POST /:id/stream/start — Start video stream
musicBotRoutes.post('/:id/stream/start', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { source, preset, framerate, bitrate } = req.body;
    if (!source) throw new AppError(400, 'source is required');
    await bot.startVideoStream(source, preset, framerate, bitrate);
    res.json({ success: true, status: bot.videoStreamStatus });
  } catch (err) { next(err); }
});

// POST /:id/stream/stop — Stop video stream
musicBotRoutes.post('/:id/stream/stop', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    await bot.stopVideoStream();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/source — Change video source
musicBotRoutes.post('/:id/stream/source', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { source } = req.body;
    if (!source) throw new AppError(400, 'source is required');
    await bot.setVideoSource(source);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /:id/stream/status — Get video stream status
musicBotRoutes.get('/:id/stream/status', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    res.json(bot.videoStreamStatus);
  } catch (err) { next(err); }
});

// DELETE /:id/stream/viewer/:clid — Kick a viewer
musicBotRoutes.delete('/:id/stream/viewer/:clid', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    await bot.kickVideoViewer(parseInt(req.params.clid as string));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/offer — Get WebRTC offer for preview player
musicBotRoutes.post('/:id/stream/webrtc/offer', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const offer = await bot.getWebRtcOffer();
    if (!offer) throw new AppError(400, 'No active video stream');
    res.json(offer);
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/answer — Set WebRTC answer from preview player
musicBotRoutes.post('/:id/stream/webrtc/answer', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { sdp } = req.body;
    if (!sdp) throw new AppError(400, 'sdp is required');
    await bot.setWebRtcAnswer(sdp);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/stream/webrtc/ice — Add ICE candidate from preview player
musicBotRoutes.post('/:id/stream/webrtc/ice', async (req: Request, res: Response, next) => {
  try {
    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(parseInt(req.params.id as string));
    if (!bot) throw new AppError(404, 'Music bot not found');
    const { candidate, sdpMid, sdpMLineIndex } = req.body;
    await bot.addWebRtcIceCandidate(candidate, sdpMid, sdpMLineIndex ?? 0);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /:id/player-widget-token — Get the public player widget token for this bot
musicBotRoutes.get('/:id/player-widget-token', async (req: Request, res: Response, next) => {
  try {
    const id = parseInt(req.params.id as string);
    const token = playerWidgetToken(id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      token,
      jsonUrl: `${baseUrl}/api/widget/player/${id}/data?token=${token}`,
      bbcodeUrl: `${baseUrl}/api/widget/player/${id}/bbcode?token=${token}`,
    });
  } catch (err) { next(err); }
});
