import { EventEmitter } from 'events';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { WebSocketServer } from 'ws';
import { VoiceBot, type VoiceBotConfig, type VoiceBotStatus } from './voice-bot.js';
import { generateIdentityAsync, restoreIdentity, type IdentityData } from './tslib/index.js';
import { publicItem, type QueueItem } from './playlist/queue.js';
import type { MusicCommandHandler } from './music-command-handler.js';
import { decrypt, encrypt } from '../utils/crypto.js';

const PROGRESS_INTERVAL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 30000;
const RECONNECT_GRACE_PERIOD_MS = 5000;

/** Music behaviour settings stored on the MusicBot row */
export function musicSettingsFromDb(dbBot: any): Partial<VoiceBotConfig> {
  return {
    normalize: dbBot.normalize ?? true,
    autoplay: dbBot.autoplay ?? false,
    announce: dbBot.announce ?? true,
    autoPauseEmpty: dbBot.autoPauseEmpty ?? true,
    nowPlayingNick: dbBot.nowPlayingNick ?? true,
    commandPrefix: dbBot.commandPrefix || '!',
    defaultSearch: dbBot.defaultSearch === 'soundcloud' ? 'soundcloud' : 'youtube',
    djGroupIds: String(dbBot.djGroupIds ?? '').split(/[,\s]+/).map((x) => parseInt(x)).filter((x) => !isNaN(x) && x > 0),
    djOnly: dbBot.djOnly ?? false,
    maxQueuePerUser: dbBot.maxQueuePerUser ?? 0,
    voteSkipPercent: dbBot.voteSkipPercent ?? 50,
    eqPreset: dbBot.eqPreset || 'flat',
    resumeQueue: dbBot.resumeQueue ?? true,
  };
}

interface ReconnectState {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class VoiceBotManager extends EventEmitter {
  private bots = new Map<number, VoiceBot>();
  private progressTimers = new Map<number, ReturnType<typeof setInterval>>();
  private reconnectState = new Map<number, ReconnectState>();
  private musicCmdHandler: MusicCommandHandler | null = null;

  constructor(
    private prisma: PrismaClient,
    private wss: WebSocketServer,
  ) {
    super();
  }

  setMusicCommandHandler(handler: MusicCommandHandler): void {
    this.musicCmdHandler = handler;
    // Register all existing bots
    for (const [id, bot] of this.bots) {
      handler.registerBot(id, bot);
    }
  }

  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private persistPending = new Map<number, ReturnType<typeof setTimeout>>();
  /** Bots whose saved queue has not been restored yet – never overwrite it in that window */
  private restorePending = new Set<number>();

  /** Save the queue of a bot (debounced) so it can resume after a restart. */
  persistQueue(botId: number, immediate = false): void {
    const bot = this.bots.get(botId);
    if (!bot || !bot.currentConfig.resumeQueue || this.restorePending.has(botId)) return;
    // A disconnect / shutdown must not overwrite the last "playing" snapshot
    if (bot.status === 'stopped' || bot.status === 'starting' || bot.status === 'error') return;
    const run = () => {
      this.persistPending.delete(botId);
      const snap = bot.snapshot();
      (this.prisma as any).musicBot.update({ where: { id: botId }, data: { savedQueue: JSON.stringify(snap) } })
        .catch((err: any) => console.error(`[VoiceBotManager] Could not save queue of bot ${botId}: ${err.message}`));
    };
    const pending = this.persistPending.get(botId);
    if (pending) clearTimeout(pending);
    if (immediate) run();
    else this.persistPending.set(botId, setTimeout(run, 2000));
  }

  private async restoreQueue(botId: number): Promise<void> {
    try {
      await this.doRestoreQueue(botId);
    } finally {
      this.restorePending.delete(botId);
    }
  }

  private async doRestoreQueue(botId: number): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot || !bot.currentConfig.resumeQueue) return;
    const row: any = await this.prisma.musicBot.findUnique({ where: { id: botId } });
    if (!row?.savedQueue) return;
    try {
      const snap = JSON.parse(row.savedQueue);
      // Ignore very old snapshots (> 7 days)
      if (!snap?.savedAt || Date.now() - snap.savedAt > 7 * 86400_000) return;
      const ok = await bot.restore(snap);
      if (ok) console.log(`[VoiceBotManager] Bot ${botId}: restored queue (${snap.items.length} tracks${snap.playing ? ', resuming playback' : ''})`);
    } catch (err: any) {
      console.warn(`[VoiceBotManager] Bot ${botId}: could not restore queue: ${err.message}`);
    }
  }

  async start(): Promise<void> {
    if (!this.persistTimer) {
      // Keep the position fresh while playing (survives crashes / container updates)
      this.persistTimer = setInterval(() => {
        for (const [id, bot] of this.bots) if (bot.status === 'playing') this.persistQueue(id, true);
      }, 15_000);
    }
    const dbBots = await this.prisma.musicBot.findMany({
      include: { serverConfig: true },
    });

    console.log(`[VoiceBotManager] Loading ${dbBots.length} music bot(s)...`);

    for (const dbBot of dbBots) {
      let identity: IdentityData | undefined;
      if (dbBot.identityData) {
        try {
          // H8: Decrypt identity data before parsing
          const parsed = JSON.parse(decrypt(dbBot.identityData));
          // Reconstruct KeyObjects from serialized scalar data
          identity = restoreIdentity(parsed);
        } catch (err: any) {
          console.error(`[VoiceBotManager] Bot ${dbBot.id} ("${dbBot.name}"): cannot decrypt identity (${err.message}) — ENCRYPTION_KEY changed? Delete and re-create this bot.`);
          continue;
        }
      }
      const config: VoiceBotConfig = {
        id: dbBot.id,
        serverConfigId: dbBot.serverConfigId,
        name: dbBot.name,
        serverHost: dbBot.serverConfig.host,
        serverPort: dbBot.voicePort ?? 9987,
        nickname: dbBot.nickname,
        serverPassword: dbBot.serverPassword ?? undefined,
        defaultChannel: dbBot.defaultChannel ?? undefined,
        channelPassword: dbBot.channelPassword ?? undefined,
        volume: dbBot.volume,
        identity,
        sidecarBinaryPath: process.env.SIDECAR_BINARY_PATH,
        sidecarPort: (dbBot as any).sidecarPort ?? 9800,
        streamPreset: (dbBot as any).streamPreset ?? '720p',
        ...musicSettingsFromDb(dbBot),
      };

      const bot = this.createBotInstance(config);
      this.bots.set(dbBot.id, bot);

      if (dbBot.autoStart) {
        bot.start().catch((err) => {
          console.error(`[VoiceBotManager] Auto-start failed for bot ${dbBot.id}: ${err.message}`);
        });
      }
    }
  }

  private createBotInstance(config: VoiceBotConfig): VoiceBot {
    const bot = new VoiceBot(config);

    bot.on('statusChange', (status: VoiceBotStatus) => {
      this.broadcast('music:bot:status', { botId: config.id, status });
      if (status === 'connected' || status === 'paused') this.persistQueue(config.id);

      if (status === 'playing') {
        this.startProgressBroadcast(config.id);
      } else {
        this.stopProgressBroadcast(config.id);
      }
    });

    bot.on('error', (err: Error) => {
      console.error(`[VoiceBotManager] Bot ${config.id} error: ${err.message}`);
    });

    bot.on('nowPlaying', (item: QueueItem) => {
      this.persistQueue(config.id);
      const progress = bot.playbackProgress;
      this.broadcast('music:bot:nowPlaying', {
        botId: config.id,
        song: { id: item.id, title: item.title, artist: item.artist, duration: item.duration, source: item.source, thumbnail: item.thumbnail, requestedBy: item.requestedBy },
        progress: progress ? { position: progress.position, duration: progress.duration } : null,
      });
    });

    bot.on('trackEnd', (item: QueueItem | null) => {
      this.broadcast('music:bot:trackEnd', { botId: config.id, songId: item?.id ?? null });
      this.persistQueue(config.id);
    });

    let restoredOnce = false;
    bot.on('connected', () => {
      // Only right after (re)connect with an empty in-memory queue, or once after process start
      if (!restoredOnce || bot.queue.length === 0) {
        restoredOnce = true;
        this.restorePending.add(config.id);
        setTimeout(() => this.restoreQueue(config.id), 1500);
      }
    });

    bot.on('volumeChange', (volume: number) => {
      this.broadcast('music:bot:volumeChange', { botId: config.id, volume });
    });

    bot.on('metadataChange', (item: QueueItem) => {
      this.broadcast('music:bot:nowPlaying', {
        botId: config.id,
        song: { id: item.id, title: item.title, artist: item.artist, duration: item.duration, source: item.source, thumbnail: item.thumbnail, requestedBy: item.requestedBy },
        progress: null,
      });
    });

    bot.on('trackError', (data: { item: QueueItem; error: string }) => {
      this.broadcast('music:bot:trackError', { botId: config.id, title: data.item?.title, error: data.error });
    });

    bot.on('listenersChange', (count: number) => {
      this.broadcast('music:bot:listeners', { botId: config.id, count });
    });

    bot.on('disconnected', () => {
      if (!bot.manuallyStopped) {
        console.log(`[VoiceBotManager] Bot ${config.id}: unexpected disconnect, scheduling reconnect`);
        this.scheduleReconnect(config.id);
      }
    });

    // Video streaming events
    bot.on('videoStreamStarted', (data: any) => {
      this.broadcast('music:bot:videoStreamStarted', { botId: config.id, ...data });
    });

    bot.on('videoStreamStopped', () => {
      this.broadcast('music:bot:videoStreamStopped', { botId: config.id });
    });

    bot.on('videoViewerJoined', (viewer: any) => {
      this.broadcast('music:bot:videoViewerJoined', { botId: config.id, viewer });
    });

    bot.on('videoViewerLeft', (clid: number) => {
      this.broadcast('music:bot:videoViewerLeft', { botId: config.id, clid });
    });

    bot.on('videoSourceChanged', (source: string) => {
      this.broadcast('music:bot:videoSourceChanged', { botId: config.id, source });
    });

    bot.on('fatalError', (msg: string) => {
      console.error(`[VoiceBotManager] Bot ${config.id}: fatal error — ${msg}. No reconnect.`);
      this.clearReconnect(config.id);
      this.broadcast('music:bot:error', { botId: config.id, error: msg });
    });

    // Register for music text commands
    if (this.musicCmdHandler) {
      this.musicCmdHandler.registerBot(config.id, bot);
    }

    return bot;
  }

  async createBot(data: {
    name: string;
    serverConfigId: number;
    nickname?: string;
    serverPassword?: string;
    defaultChannel?: string;
    channelPassword?: string;
    voicePort?: number;
    volume?: number;
    autoStart?: boolean;
    normalize?: boolean;
    autoplay?: boolean;
    announce?: boolean;
    autoPauseEmpty?: boolean;
    nowPlayingNick?: boolean;
    commandPrefix?: string;
    defaultSearch?: string;
    djGroupIds?: string;
    djOnly?: boolean;
    maxQueuePerUser?: number;
    voteSkipPercent?: number;
    eqPreset?: string;
    resumeQueue?: boolean;
  }): Promise<{ id: number }> {
    // Enforce bot limit
    const limitSetting = await this.prisma.appSetting.findUnique({ where: { key: 'max_music_bots' } });
    const limit = parseInt(limitSetting?.value ?? '10') || 10;
    const currentCount = await this.prisma.musicBot.count();
    if (currentCount >= limit) {
      throw new Error(`Music bot limit reached (${limit}). Adjust the limit in Settings.`);
    }

    // Generate identity with security level high enough for most servers (default minimum is 8, many use 21+)
    // Uses worker thread to avoid blocking the event loop (~5s of SHA1 brute-force)
    const identity = await generateIdentityAsync(23);
    // H8: Encrypt identity data at rest
    const identityData = encrypt(JSON.stringify(identity, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));

    // Get server config for host
    const serverConfig = await this.prisma.tsServerConfig.findUnique({ where: { id: data.serverConfigId } });
    if (!serverConfig) throw new Error('Server config not found');

    const dbBot = await this.prisma.musicBot.create({
      data: {
        name: data.name,
        serverConfigId: data.serverConfigId,
        nickname: data.nickname ?? 'MusicBot',
        serverPassword: data.serverPassword,
        defaultChannel: data.defaultChannel,
        channelPassword: data.channelPassword,
        voicePort: data.voicePort ?? 9987,
        volume: data.volume ?? 50,
        autoStart: data.autoStart ?? false,
        identityData,
        ...(data.normalize !== undefined && { normalize: data.normalize }),
        ...(data.autoplay !== undefined && { autoplay: data.autoplay }),
        ...(data.announce !== undefined && { announce: data.announce }),
        ...(data.autoPauseEmpty !== undefined && { autoPauseEmpty: data.autoPauseEmpty }),
        ...(data.nowPlayingNick !== undefined && { nowPlayingNick: data.nowPlayingNick }),
        ...(data.commandPrefix && { commandPrefix: data.commandPrefix }),
        ...(data.defaultSearch && { defaultSearch: data.defaultSearch }),
        ...(data.djGroupIds !== undefined && { djGroupIds: data.djGroupIds }),
        ...(data.djOnly !== undefined && { djOnly: data.djOnly }),
        ...(data.maxQueuePerUser !== undefined && { maxQueuePerUser: data.maxQueuePerUser }),
        ...(data.voteSkipPercent !== undefined && { voteSkipPercent: data.voteSkipPercent }),
        ...(data.eqPreset && { eqPreset: data.eqPreset }),
        ...(data.resumeQueue !== undefined && { resumeQueue: data.resumeQueue }),
      } as any,
    });

    const config: VoiceBotConfig = {
      id: dbBot.id,
      serverConfigId: data.serverConfigId,
      name: dbBot.name,
      serverHost: serverConfig.host,
      serverPort: dbBot.voicePort ?? 9987,
      nickname: dbBot.nickname,
      serverPassword: dbBot.serverPassword ?? undefined,
      defaultChannel: dbBot.defaultChannel ?? undefined,
      channelPassword: dbBot.channelPassword ?? undefined,
      volume: dbBot.volume,
      identity,
      sidecarBinaryPath: process.env.SIDECAR_BINARY_PATH,
      sidecarPort: 9800,
      streamPreset: '720p',
      ...musicSettingsFromDb(dbBot),
    };

    const bot = this.createBotInstance(config);
    this.bots.set(dbBot.id, bot);

    return { id: dbBot.id };
  }

  getBot(id: number): VoiceBot | undefined {
    return this.bots.get(id);
  }

  async removeBot(id: number): Promise<void> {
    this.clearReconnect(id);
    const bot = this.bots.get(id);
    if (bot && bot.status !== 'stopped') {
      await bot.stop();
    }
    this.stopProgressBroadcast(id);
    this.bots.delete(id);
    await this.prisma.musicBot.delete({ where: { id } });
  }

  async getBotsForServer(configId: number): Promise<Array<{ botId: number; bot: VoiceBot }>> {
    const dbBots = await this.prisma.musicBot.findMany({
      where: { serverConfigId: configId },
      select: { id: true },
    });
    const result: Array<{ botId: number; bot: VoiceBot }> = [];
    for (const db of dbBots) {
      const bot = this.bots.get(db.id);
      if (bot && bot.status !== 'stopped') {
        result.push({ botId: db.id, bot });
      }
    }
    return result;
  }

  listBots(): Array<{ id: number; status: VoiceBotStatus; nowPlaying: ReturnType<typeof publicItem>; listeners: number; channelName: string; queueLength: number }> {
    const list: Array<{ id: number; status: VoiceBotStatus; nowPlaying: ReturnType<typeof publicItem>; listeners: number; channelName: string; queueLength: number }> = [];
    for (const [id, bot] of this.bots) {
      const running = bot.status !== 'stopped' && bot.status !== 'error';
      list.push({
        id,
        status: bot.status,
        nowPlaying: publicItem(bot.nowPlaying),
        listeners: running ? bot.channelListeners.length : 0,
        channelName: running ? bot.channelName : '',
        queueLength: bot.queue.upcomingCount,
      });
    }
    return list;
  }

  async startBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Music bot ${id} is not loaded – its identity could not be read (ENCRYPTION_KEY changed?). Delete the bot and create it again.`);
    this.clearReconnect(id);
    await bot.start();
  }

  async stopBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Music bot ${id} not found`);
    this.clearReconnect(id);
    await bot.stop();
  }

  async stopAll(): Promise<void> {
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
    // Save the latest positions before shutting down
    for (const [id, bot] of this.bots) if (bot.status === 'playing' || bot.status === 'paused') this.persistQueue(id, true);
    // Clear all reconnect timers first to prevent reconnect during shutdown
    for (const [id, state] of this.reconnectState) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.reconnectState.clear();

    const promises: Promise<void>[] = [];
    for (const bot of this.bots.values()) {
      if (bot.status !== 'stopped') {
        promises.push(bot.stop());
      }
    }
    this.progressTimers.forEach((timer) => clearInterval(timer));
    this.progressTimers.clear();
    await Promise.allSettled(promises);
  }

  // --- Auto-reconnect logic ---

  private scheduleReconnect(botId: number): void {
    const bot = this.bots.get(botId);
    if (!bot) return;

    let state = this.reconnectState.get(botId);
    if (!state) {
      state = { attempts: 0, timer: null };
      this.reconnectState.set(botId, state);
    }

    // Prevent double-scheduling (can happen when both 'disconnected' handler
    // and attemptReconnect catch block trigger simultaneously)
    if (state.timer) return;

    if (state.attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[VoiceBotManager] Bot ${botId}: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      this.broadcast('music:bot:reconnectFailed', { botId });
      this.reconnectState.delete(botId);
      return;
    }

    const delay = Math.min(Math.pow(2, state.attempts) * 1000, MAX_RECONNECT_DELAY_MS);
    state.attempts++;
    console.log(`[VoiceBotManager] Bot ${botId}: reconnect attempt ${state.attempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);

    state.timer = setTimeout(() => this.attemptReconnect(botId), delay);
  }

  private async attemptReconnect(botId: number): Promise<void> {
    const bot = this.bots.get(botId);
    const state = this.reconnectState.get(botId);
    if (!bot || !state) return;

    // Don't reconnect if bot hit a fatal error (wrong password, banned, etc.)
    if (bot.status === 'error') {
      console.log(`[VoiceBotManager] Bot ${botId}: in error state, aborting reconnect`);
      this.reconnectState.delete(botId);
      return;
    }

    // Mark timer as executed so scheduleReconnect can run again
    state.timer = null;

    try {
      // Ensure previous connection is fully cleaned up before reconnecting
      // This prevents duplicate clients when the TS server restarts
      bot.ensureDisconnected();
      await new Promise((r) => setTimeout(r, RECONNECT_GRACE_PERIOD_MS));

      await bot.start();
      console.log(`[VoiceBotManager] Bot ${botId}: reconnected successfully after ${state.attempts} attempt(s)`);
      this.reconnectState.delete(botId);
    } catch (err: any) {
      console.error(`[VoiceBotManager] Bot ${botId}: reconnect attempt ${state.attempts} failed: ${err.message}`);
      // Schedule next attempt (guard in scheduleReconnect prevents double-scheduling
      // if 'disconnected' event also fires from the failed connect)
      this.scheduleReconnect(botId);
    }
  }

  private clearReconnect(botId: number): void {
    const state = this.reconnectState.get(botId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.reconnectState.delete(botId);
  }

  private startProgressBroadcast(botId: number): void {
    this.stopProgressBroadcast(botId);
    const timer = setInterval(() => {
      const bot = this.bots.get(botId);
      if (!bot || bot.status !== 'playing') {
        this.stopProgressBroadcast(botId);
        return;
      }
      const progress = bot.playbackProgress;
      if (progress) {
        this.broadcast('music:bot:progress', {
          botId,
          position: progress.position,
          duration: progress.duration,
        });
      }
    }, PROGRESS_INTERVAL_MS);
    this.progressTimers.set(botId, timer);
  }

  private stopProgressBroadcast(botId: number): void {
    const timer = this.progressTimers.get(botId);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(botId);
    }
  }

  private broadcast(type: string, payload: any): void {
    const msg = JSON.stringify({ type, ...payload });
    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }
}
