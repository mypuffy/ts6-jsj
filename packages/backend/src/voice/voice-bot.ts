import { EventEmitter } from 'events';
import fs from 'fs';
import type { ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import { Ts3Client, type Ts3ClientOptions, generateIdentity, type IdentityData, buildCommand, type ParsedCommand } from './tslib/index.js';
import { AudioPipeline, FRAME_MS, BYTES_PER_FRAME, SAMPLE_RATE, CHANNELS } from './audio/pipeline.js';
import { PlayQueue, type QueueItem } from './playlist/queue.js';
import { fetchIcyMetadata } from './audio/icy-metadata.js';
import { resolveStream, findRelated, formatDuration, type SearchProvider } from './audio/sources.js';
import { trackToQueueItem } from './music-service.js';
import { StreamSignaling, type ActiveStream, type SignalingMessage } from './streaming/stream-signaling.js';
import { SidecarClient } from './streaming/sidecar-client.js';
import { SidecarProcess, type SidecarConfig } from './streaming/sidecar-process.js';
import { STREAM_PRESETS, DEFAULT_PRESET, type VideoViewerInfo, type VideoStreamStatus } from './streaming/types.js';
import { getCookieArgs } from './audio/youtube.js';
import { spawn } from 'child_process';

/** Resolve a YouTube/yt-dlp-compatible URL to a direct stream URL */
function resolveVideoUrl(url: string, maxHeight: number = 720): Promise<string> {
  // Only resolve YouTube and other yt-dlp-supported sites
  if (!url.includes('youtube.com/') && !url.includes('youtu.be/') && !url.includes('twitch.tv/')) {
    return Promise.resolve(url);
  }

  return new Promise((resolve, reject) => {
    // Request best combined format (video+audio) up to the target height
    const formatFilter = `best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]/best[ext=mp4]/best`;
    const proc = spawn('yt-dlp', [
      ...getCookieArgs(),
      '-f', formatFilter,
      '--no-playlist',
      '-g',  // print direct URL only
      url,
    ], { shell: false });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(0, 200)}`));
      }
      // yt-dlp -g returns the direct URL(s), take the first one
      const directUrl = stdout.trim().split('\n')[0];
      if (!directUrl) {
        return reject(new Error('yt-dlp returned no URL'));
      }
      console.log(`[VideoResolve] Resolved: ${url.substring(0, 60)}... → direct URL`);
      resolve(directUrl);
    });

    proc.on('error', (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

export type VoiceBotStatus = 'stopped' | 'starting' | 'connected' | 'playing' | 'paused' | 'error';

export interface PlaybackProgress {
  position: number;  // seconds
  duration: number;  // seconds
}

export interface VoiceBotConfig {
  id: number;
  serverConfigId: number;
  name: string;
  serverHost: string;
  serverPort: number;
  nickname: string;
  serverPassword?: string;
  defaultChannel?: string;
  channelPassword?: string;
  volume: number; // 0-100
  identity?: IdentityData;
  sidecarBinaryPath?: string;
  sidecarPort?: number;
  streamPreset?: string;
  // ── Music behaviour ──
  /** Loudness normalization between tracks */
  normalize?: boolean;
  /** When the queue runs out, keep playing related tracks */
  autoplay?: boolean;
  /** Post "Now playing" into the bot's channel */
  announce?: boolean;
  /** Pause automatically when nobody is in the bot's channel */
  autoPauseEmpty?: boolean;
  /** Show the current track in the bot's nickname */
  nowPlayingNick?: boolean;
  /** Prefix for chat commands, default "!" */
  commandPrefix?: string;
  /** Provider for "!play <text>" searches */
  defaultSearch?: SearchProvider;
  /** Server group ids that count as DJ (empty = everybody) */
  djGroupIds?: number[];
  /** Control commands (skip, volume, stop…) only for DJs */
  djOnly?: boolean;
  /** Max. queued tracks per user (0 = unlimited, DJs exempt) */
  maxQueuePerUser?: number;
  /** % of listeners needed for !voteskip */
  voteSkipPercent?: number;
  /** EQ preset key */
  eqPreset?: string;
  /** Restore queue after a restart */
  resumeQueue?: boolean;
}

export interface QueueSnapshot {
  items: QueueItem[];
  index: number;
  position: number;
  playing: boolean;
  savedAt: number;
}

export interface HistoryEntry {
  id: string;
  title: string;
  artist?: string;
  source: string;
  sourceUrl?: string;
  thumbnail?: string;
  duration?: number;
  requestedBy?: string;
  playedAt: number;
}

interface ChannelClient {
  cid: number;
  nickname: string;
  type: number; // 0 = human, 1 = query
  groups: number[];
  uid?: string;
}

interface PlaybackSession {
  item: QueueItem;
  getError: () => string;
  viaYtDlp: boolean;
  stdout: Readable;
  proc: ChildProcess;
  kill: () => void;
  chunks: Buffer[];
  size: number;
  ended: boolean;
  killed: boolean;
  exitCode: number | null;
  framesSent: number;
  startOffset: number;
  isLive: boolean;
  stdoutPaused: boolean;
  needsRestart: boolean;
  recoverCount: number;
  input: string;
}

const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * 2;
const HIGH_WATER = BYTES_PER_SEC * 10;   // decode at most 10 s ahead (~1.9 MB)
const LOW_WATER = BYTES_PER_SEC * 4;
const PREBUFFER = BYTES_PER_FRAME * 20;  // 400 ms before the first frame
const PAUSE_KILL_MS = 45_000;            // free FFmpeg after a long pause
const STREAM_URL_TTL_MS = 20 * 60_000;   // re-resolve signed CDN URLs after 20 min
const PREFETCH_BEFORE_END_S = 20;
const MAX_RECOVER = 3;
const MAX_CONSECUTIVE_FAILS = 5;
const HISTORY_MAX = 100;

export class VoiceBot extends EventEmitter {
  private client: Ts3Client;
  private pipeline: AudioPipeline;
  readonly queue: PlayQueue;
  private config: VoiceBotConfig;
  private _status: VoiceBotStatus = 'stopped';
  private _lastError: string = '';
  private identity: IdentityData | null = null;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _nowPlaying: QueueItem | null = null;

  // Streaming playback state
  private session: PlaybackSession | null = null;
  private loopEpoch: number = 0;
  private playToken: number = 0;
  private pauseKillTimer: ReturnType<typeof setTimeout> | null = null;
  private failStreak: number = 0;
  private prefetchFor: string | null = null;
  private _isStreaming: boolean = false;
  private streamStartTime: number = 0;
  private _loading: boolean = false;

  private lastVoiceSendAt = 0;       // performance.now() timestamp
  private statWindowStart = 0;
  private statCount = 0;
  private statDtSum = 0;
  private statDtMin = Number.POSITIVE_INFINITY;
  private statDtMax = 0;

  /** Queue items whose direct stream URL failed – these use the yt-dlp pipe */
  private pipeModeItems = new WeakSet<QueueItem>();

  /** Recently played tracks, newest first */
  readonly history: HistoryEntry[] = [];

  // Channel awareness (clients in view, own channel)
  private clients = new Map<number, ChannelClient>();
  private _autoPaused = false;

  // Nickname "now playing" state
  private _originalNickname: string;

  // ICY metadata polling (radio)
  private icyPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamTitle: string = '';

  // Reconnect: distinguishes manual stop from unexpected disconnect
  private _manuallyStopped: boolean = false;

  // Video streaming state
  private signaling: StreamSignaling | null = null;
  private sidecarProc: SidecarProcess | null = null;
  private sidecarHttp: SidecarClient | null = null;
  private _videoStreaming: boolean = false;
  private _activeStreamId: string | null = null;
  private _videoSource: string | null = null;
  private _videoPreset: string = DEFAULT_PRESET;
  private _videoFramerate: number = STREAM_PRESETS[DEFAULT_PRESET]?.framerate ?? 30;
  private _videoBitrate: string = STREAM_PRESETS[DEFAULT_PRESET]?.bitrate ?? '2500k';
  private _videoStartedAt: number | null = null;
  private _viewers: Map<number, VideoViewerInfo> = new Map();

  constructor(config: VoiceBotConfig) {
    super();
    this.config = config;
    this._originalNickname = config.nickname;
    this.client = new Ts3Client();
    this.pipeline = new AudioPipeline();
    this.queue = new PlayQueue();

    // VOICE_DEBUG=1 → full TS protocol log (handshake, commands, errors)
    if (process.env.VOICE_DEBUG === '1') {
      this.client.on('debug', (m: string) => console.log(`[VoiceBot ${config.id}] ${m}`));
    }

    this.client.on('error', (err) => {
      console.error(`[VoiceBot ${config.id}] Connection error: ${err?.message ?? err}`);
      this._status = 'error';
      this.emit('error', err);
      this.emit('statusChange', this._status);
    });

    this.client.on('disconnected', () => {
      console.log(`[VoiceBot ${config.id}] Disconnected${this._lastError ? ` (last error: ${this._lastError})` : ''}`);
      this.stopIcyPolling();
      this.stopPlayback();
      this.clients.clear();
      this._status = 'stopped';
      this._nowPlaying = null;
      this.emit('statusChange', this._status);
      this.emit('disconnected');
    });

    this.client.on('ts3error', (params: Record<string, string>) => {
      const id = parseInt(params.id || '0');
      const msg = params.msg || 'unknown error';
      if (id === 0) return; // "ok" responses
      this._lastError = `TS3 error ${id}: ${msg}`;
      // Fatal errors that should not trigger reconnect
      // 2568 = invalid password, 3329 = banned, 1796 = max clients reached
      if (id === 2568 || id === 3329 || id === 1796) {
        this._status = 'error';
        this.emit('statusChange', this._status);
        this.emit('fatalError', this._lastError);
      }
    });

    this.client.on('command', (cmd: ParsedCommand) => {
      this.trackClients(cmd);
      this.emit('command', cmd);
    });

    this.client.on('textMessage', (data: Record<string, string>) => {
      this.emit('textMessage', data);
    });
  }

  // ─── Getters ────────────────────────────────────────────────

  get id(): number {
    return this.config.id;
  }

  get status(): VoiceBotStatus {
    return this._status;
  }

  get nowPlaying(): QueueItem | null {
    return this._nowPlaying;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /** True while a track is being resolved / buffered */
  get loading(): boolean {
    return this._loading;
  }

  get autoPaused(): boolean {
    return this._autoPaused;
  }

  get manuallyStopped(): boolean {
    return this._manuallyStopped;
  }

  get position(): number {
    if (!this.session) return 0;
    return this.session.startOffset + (this.session.framesSent * FRAME_MS) / 1000;
  }

  get playbackProgress(): PlaybackProgress | null {
    if (!this._nowPlaying) return null;
    if (this._isStreaming) {
      return {
        position: (Date.now() - this.streamStartTime) / 1000,
        duration: 0, // Live stream — no known duration
      };
    }
    return {
      position: this.position,
      duration: this._nowPlaying.duration ?? 0,
    };
  }

  get lastError(): string {
    return this._lastError;
  }

  get ts3ClientId(): number {
    return this.client.getClientId();
  }

  get currentConfig(): VoiceBotConfig {
    return { ...this.config };
  }

  /** Channel the bot is currently in (0 = unknown) */
  get channelId(): number {
    return this.clients.get(this.client.getClientId())?.cid ?? 0;
  }

  get channelName(): string {
    const cid = this.channelId;
    return this.client.getChannels().find((c) => c.cid === cid)?.name ?? '';
  }

  getChannels(): Array<{ cid: number; name: string }> {
    return this.client.getChannels().sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Human listeners in the bot's channel (excluding the bot itself) */
  get channelListeners(): Array<{ clid: number; nickname: string }> {
    const cid = this.channelId;
    const self = this.client.getClientId();
    if (!cid) return [];
    const out: Array<{ clid: number; nickname: string }> = [];
    for (const [clid, c] of this.clients) {
      if (clid !== self && c.cid === cid && c.type === 0) out.push({ clid, nickname: c.nickname });
    }
    return out;
  }

  getClientNickname(clid: number): string | undefined {
    return this.clients.get(clid)?.nickname;
  }

  getClientChannel(clid: number): number {
    return this.clients.get(clid)?.cid ?? 0;
  }

  getClientGroups(clid: number): number[] {
    return this.clients.get(clid)?.groups ?? [];
  }

  /** True if the client is in one of the configured DJ groups (or no DJ groups are configured). */
  isDj(clid: number): boolean {
    const dj = this.config.djGroupIds ?? [];
    if (dj.length === 0) return true;
    return this.getClientGroups(clid).some((g) => dj.includes(g));
  }

  // ─── EQ / sleep timer ───────────────────────────────────────

  get eqPreset(): string {
    return this.config.eqPreset || 'flat';
  }

  /** Change EQ – the running track restarts at the current position with the new filter. */
  setEq(preset: string): void {
    this.config.eqPreset = preset;
    if (this._status === 'playing' && this._nowPlaying) {
      if (this._isStreaming) {
        const item = this._nowPlaying;
        const token = this.playToken;
        this.clearTimer();
        this.startSession(item, 0, token, 0).catch((err) => { if (token === this.playToken) this.finishTrack(item, err); });
      } else {
        this.seek(this.position);
      }
    }
  }

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private _sleepUntil = 0;

  get sleepUntil(): number {
    return this._sleepUntil;
  }

  /** Stop playback after `minutes` (0 = cancel). */
  setSleepTimer(minutes: number): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this._sleepUntil = 0;
    if (!minutes || minutes <= 0) return;
    const ms = Math.min(minutes, 24 * 60) * 60_000;
    this._sleepUntil = Date.now() + ms;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      this._sleepUntil = 0;
      if (this.config.announce) {
        try { this.sendChannelMessage('\uD83D\uDCA4 Sleep timer – good night!'); } catch { }
      }
      this.stopAudio();
    }, ms);
  }

  // ─── Queue snapshot (resume after restart) ──────────────────

  snapshot(): QueueSnapshot {
    return {
      items: this.queue.getAll().map(({ resolved: _r, ...rest }) => rest as QueueItem),
      index: this.queue.index,
      position: this._isStreaming ? 0 : this.position,
      playing: this._status === 'playing' || this._status === 'paused',
      savedAt: Date.now(),
    };
  }

  /** Restore a snapshot. Starts playback at the saved position if it was playing. */
  async restore(snap: QueueSnapshot): Promise<boolean> {
    if (!snap?.items?.length) return false;
    this.queue.clear();
    this.queue.addMany(snap.items);
    if (!snap.playing || snap.index < 0) return true;
    const item = this.queue.playAt(Math.min(snap.index, this.queue.length - 1));
    if (!item) return true;
    try {
      await this.play(item, item.source === 'radio' ? 0 : Math.max(0, snap.position - 2));
    } catch (err: any) {
      console.warn(`[VoiceBot ${this.config.id}] Could not resume "${item.title}": ${err.message}`);
    }
    return true;
  }

  updateConfig(partial: Partial<VoiceBotConfig>): void {
    Object.assign(this.config, partial);
    if (partial.nickname) this._originalNickname = partial.nickname;
    if (partial.nowPlayingNick === false) this.resetNickname();
    if (partial.autoPauseEmpty === false && this._autoPaused) {
      this._autoPaused = false;
      this.resume();
    }
  }

  // ─── Text messages ──────────────────────────────────────────

  sendTextMessage(targetClid: number, msg: string): void {
    this.client.sendCommand(buildCommand('sendtextmessage', { targetmode: 1, target: targetClid, msg }));
  }

  /** Message to the bot's current channel */
  sendChannelMessage(msg: string): void {
    this.client.sendCommand(buildCommand('sendtextmessage', { targetmode: 2, target: this.channelId || 0, msg }));
  }

  /** Move the bot to another channel */
  moveToChannel(cid: number, password?: string): void {
    const self = this.client.getClientId();
    if (!self || !cid) throw new Error('Bot is not connected');
    this.client.sendCommand(buildCommand('clientmove', { cid, clid: self, cpw: password ?? '' }));
  }

  // ─── Channel awareness ──────────────────────────────────────

  private trackClients(cmd: ParsedCommand): void {
    const entries = cmd.groups ?? [cmd.params];
    let changed = false;
    switch (cmd.name) {
      case 'notifycliententerview':
        for (const e of entries) {
          const clid = parseInt(e.clid);
          if (!clid) continue;
          this.clients.set(clid, {
            cid: parseInt(e.ctid) || 0,
            nickname: e.client_nickname || `#${clid}`,
            type: parseInt(e.client_type || '0') || 0,
            groups: String(e.client_servergroups || '').split(',').map((x) => parseInt(x)).filter((x) => !isNaN(x)),
            uid: e.client_unique_identifier,
          });
          changed = true;
        }
        break;
      case 'notifyclientmoved':
        for (const e of entries) {
          const clid = parseInt(e.clid);
          if (!clid) continue;
          const c = this.clients.get(clid);
          const ctid = parseInt(e.ctid) || 0;
          if (c) c.cid = ctid || c.cid;
          else this.clients.set(clid, { cid: ctid, nickname: `#${clid}`, type: clid === this.client.getClientId() ? 1 : 0, groups: [] });
          changed = true;
        }
        break;
      case 'notifyclientleftview':
        for (const e of entries) {
          if (this.clients.delete(parseInt(e.clid))) changed = true;
        }
        break;
      case 'notifyclientupdated':
        for (const e of entries) {
          const c = this.clients.get(parseInt(e.clid));
          if (c && e.client_nickname) c.nickname = e.client_nickname;
          if (c && e.client_servergroups) c.groups = String(e.client_servergroups).split(',').map((x) => parseInt(x)).filter((x) => !isNaN(x));
        }
        break;
      case 'notifyservergroupclientadded':
        for (const e of entries) {
          const c = this.clients.get(parseInt(e.clid));
          const sgid = parseInt(e.sgid);
          if (c && !isNaN(sgid) && !c.groups.includes(sgid)) c.groups.push(sgid);
        }
        break;
      case 'notifyservergroupclientdeleted':
        for (const e of entries) {
          const c = this.clients.get(parseInt(e.clid));
          const sgid = parseInt(e.sgid);
          if (c) c.groups = c.groups.filter((g) => g !== sgid);
        }
        break;
    }
    if (changed) {
      this.emit('listenersChange', this.channelListeners.length);
      this.checkAutoPause();
    }
  }

  private checkAutoPause(): void {
    if (!this.config.autoPauseEmpty || !this.channelId) return;
    const empty = this.channelListeners.length === 0;
    if (empty && this._status === 'playing' && !this._isStreaming) {
      this._autoPaused = true;
      this.pause();
      console.log(`[VoiceBot ${this.config.id}] Channel empty — auto-paused`);
    } else if (empty && this._status === 'playing' && this._isStreaming) {
      // Radio: just stop the stream, resume will reconnect
      this._autoPaused = true;
      this.pause();
    } else if (!empty && this._autoPaused && this._status === 'paused') {
      this._autoPaused = false;
      this.resume();
      console.log(`[VoiceBot ${this.config.id}] Listener joined — resumed`);
    }
  }

  // ─── Nickname / announcements ───────────────────────────────

  /** Update the TS3 nickname to show what's playing. Max 30 chars. */
  private updateNowPlayingNickname(title: string): void {
    if (this._status === 'stopped' || this.config.nowPlayingNick === false) return;
    const prefix = this._originalNickname;
    const sep = ' ♪ '; // ♪
    const maxLen = 30;
    let nick = prefix + sep + title;
    if (nick.length > maxLen) {
      const available = maxLen - prefix.length - sep.length - 1; // -1 for …
      nick = prefix + sep + (available > 0 ? title.substring(0, available) + '…' : '…');
    }
    try {
      this.client.sendCommand(buildCommand('clientupdate', { client_nickname: nick }));
    } catch { }
  }

  /** Reset TS3 nickname to original. */
  private resetNickname(): void {
    if (this._status === 'stopped') return;
    try {
      this.client.sendCommand(buildCommand('clientupdate', { client_nickname: this._originalNickname }));
    } catch { }
  }

  private announce(item: QueueItem): void {
    if (!this.config.announce) return;
    const who = item.requestedBy ? ` · [i]${item.requestedBy}[/i]` : '';
    const dur = item.duration ? ` [${formatDuration(item.duration)}]` : '';
    const label = item.artist ? `${item.artist} – ${item.title}` : item.title;
    const link = item.sourceUrl ? `[url=${item.sourceUrl}]${label}[/url]` : label;
    try { this.sendChannelMessage(`▶ [b]Now playing:[/b] ${link}${dur}${who}`); } catch { }
  }

  // ─── ICY (radio) ────────────────────────────────────────────

  /** Start polling ICY metadata for a radio stream. */
  private startIcyPolling(streamUrl: string): void {
    this.stopIcyPolling();
    this.lastStreamTitle = '';
    this.fetchAndUpdateIcy(streamUrl);
    this.icyPollTimer = setInterval(() => {
      this.fetchAndUpdateIcy(streamUrl);
    }, 15000);
  }

  private async fetchAndUpdateIcy(streamUrl: string): Promise<void> {
    try {
      const title = await fetchIcyMetadata(streamUrl);
      if (!title || title === this.lastStreamTitle || !this._nowPlaying) return;
      this.lastStreamTitle = title;

      // Parse "Artist - Title" format
      const dashIdx = title.indexOf(' - ');
      if (dashIdx > 0) {
        this._nowPlaying.artist = title.substring(0, dashIdx).trim();
        this._nowPlaying.title = title.substring(dashIdx + 3).trim();
      } else {
        this._nowPlaying.title = title;
      }

      this.updateNowPlayingNickname(title);
      this.emit('metadataChange', this._nowPlaying);
    } catch { }
  }

  private stopIcyPolling(): void {
    if (this.icyPollTimer) {
      clearInterval(this.icyPollTimer);
      this.icyPollTimer = null;
    }
    this.lastStreamTitle = '';
  }

  // ─── Connection ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._status === 'connected' || this._status === 'playing' || this._status === 'paused') {
      throw new Error('Bot is already running');
    }

    this._manuallyStopped = false;
    this._status = 'starting';
    this.emit('statusChange', this._status);

    this.identity = this.config.identity ?? generateIdentity(8);

    const opts: Ts3ClientOptions = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      identity: this.identity,
      nickname: this.config.nickname,
      serverPassword: this.config.serverPassword,
      defaultChannel: this.config.defaultChannel,
      channelPassword: this.config.channelPassword,
    };

    console.log(`[VoiceBot ${this.config.id}] Connecting to ${this.config.serverHost}:${this.config.serverPort} as "${this.config.nickname}"${this.config.defaultChannel ? ` → channel "${this.config.defaultChannel}"` : ''}`);
    try {
      await this.client.connect(opts);
    } catch (err: any) {
      console.error(`[VoiceBot ${this.config.id}] Connect failed: ${err?.message ?? err}`);
      this._lastError = err?.message ?? String(err);
      throw err;
    }
    console.log(`[VoiceBot ${this.config.id}] Connected (clid=${this.client.getClientId()})`);
    this._status = 'connected';
    this.emit('statusChange', this._status);
    this.emit('connected');
  }

  async stop(): Promise<void> {
    this._manuallyStopped = true;
    this.stopIcyPolling();
    this.resetNickname();
    this.stopPlayback();
    this._nowPlaying = null;
    // Stop video stream if active
    if (this._videoStreaming) {
      await this.stopVideoStream();
    }
    this.client.disconnect();
  }

  /** Force-close the underlying socket if still open, without triggering reconnect */
  ensureDisconnected(): void {
    this.client.forceClose();
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this._status === 'stopped') resolve();
        else setTimeout(check, 100);
      };
      setTimeout(check, 600);
    });
    await this.start();
  }

  // ─── Playback API ───────────────────────────────────────────

  private assertConnected(): void {
    if (this._status !== 'connected' && this._status !== 'playing' && this._status !== 'paused') {
      throw new Error('Bot is not connected');
    }
  }

  /**
   * Play any queue item: local file, YouTube, SoundCloud, direct URL or radio.
   * Audio is streamed through FFmpeg – nothing is fully decoded into memory.
   */
  async play(item: QueueItem, startAt = 0): Promise<void> {
    this.assertConnected();
    const token = ++this.playToken;

    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = item;
    this._status = 'playing';
    this._autoPaused = false;
    this._loading = true;
    this.emit('statusChange', this._status);
    this.emit('nowPlaying', item);

    try {
      await this.startSession(item, startAt, token, 0);
    } catch (err) {
      if (token !== this.playToken) return; // superseded by another play()
      this.killSession();
      this._loading = false;
      this._nowPlaying = null;
      this._isStreaming = false;
      this._status = 'connected';
      this.emit('statusChange', this._status);
      throw err;
    }
    if (token !== this.playToken) return;

    this._loading = false;
    this.failStreak = 0;
    this.pushHistory(item);
    this.updateNowPlayingNickname(item.artist && item.source !== 'radio' ? `${item.artist} - ${item.title}` : item.title);
    this.emit('metadataChange', item);
    this.announce(item);
    // Joined an empty channel? respect auto-pause right away
    this.checkAutoPause();
  }

  /** Kept for API compatibility – radio streams use the same engine now. */
  async playStream(item: QueueItem): Promise<void> {
    return this.play(item);
  }

  /** Fire-and-forget play that skips broken tracks automatically */
  private playSafe(item: QueueItem): void {
    this.play(item).catch((err) => this.handlePlaybackFailure(item, err));
  }

  private handlePlaybackFailure(item: QueueItem, err: Error): void {
    this.failStreak++;
    this.emit('error', err);
    this.emit('trackError', { item, error: err.message });
    console.error(`[VoiceBot ${this.config.id}] Failed to play "${item.title}": ${err.message}`);
    if (this.config.announce) {
      try { this.sendChannelMessage(`⚠ Skipping [b]${item.title}[/b]: ${err.message.slice(0, 120)}`); } catch { }
    }
    if (this.failStreak >= MAX_CONSECUTIVE_FAILS) {
      this.failStreak = 0;
      this.resetNickname();
      return;
    }
    if (this._status === 'connected') this.advance(null);
  }

  private async openSource(item: QueueItem): Promise<{ input: string; headers: Record<string, string>; isLive: boolean }> {
    if (item.source === 'radio' && item.streamUrl) {
      return { input: item.streamUrl, headers: {}, isLive: true };
    }
    if (item.filePath && fs.existsSync(item.filePath)) {
      return { input: item.filePath, headers: {}, isLive: false };
    }
    if (item.sourceUrl) {
      const fresh = item.resolved && Date.now() - item.resolved.at < STREAM_URL_TTL_MS;
      if (!fresh) {
        const r = await resolveStream(item.sourceUrl);
        item.resolved = { url: r.url, headers: r.headers, isLive: r.isLive, at: r.resolvedAt };
        // Full extraction has better metadata than flat playlist entries
        if (r.info.title) item.title = r.info.title;
        if (r.info.artist) item.artist = r.info.artist;
        if (r.info.duration) item.duration = r.info.duration;
        if (r.info.thumbnail && !item.thumbnail) item.thumbnail = r.info.thumbnail;
      }
      return { input: item.resolved!.url, headers: item.resolved!.headers, isLive: item.resolved!.isLive };
    }
    if (item.streamUrl) {
      return { input: item.streamUrl, headers: {}, isLive: false };
    }
    throw new Error('Track has no playable source');
  }

  private async startSession(item: QueueItem, startAt: number, token: number, recoverCount: number): Promise<void> {
    // Items where the direct CDN URL failed are played through "yt-dlp -o - | ffmpeg"
    const viaYtDlp = !!item.sourceUrl && this.pipeModeItems.has(item);
    let stream: { stdout: Readable; process: ChildProcess; kill: () => void; getError: () => string };
    let src: { input: string; headers: Record<string, string>; isLive: boolean };

    if (viaYtDlp) {
      src = { input: item.sourceUrl!, headers: {}, isLive: false };
      stream = this.pipeline.openYtDlpPcmStream(item.sourceUrl!, {
        seek: startAt,
        normalize: this.config.normalize !== false,
        eq: this.config.eqPreset,
        ytdlpArgs: getCookieArgs(),
      });
    } else {
      src = await this.openSource(item);
      if (token !== this.playToken) return;
      stream = await this.pipeline.openPcmStream(src.input, {
        seek: src.isLive ? 0 : startAt,
        headers: src.headers,
        isLive: src.isLive,
        normalize: this.config.normalize !== false,
        eq: this.config.eqPreset,
      });
    }
    if (token !== this.playToken) { stream.kill(); return; }

    this.killSession();
    const sess: PlaybackSession = {
      item,
      getError: stream.getError,
      viaYtDlp,
      stdout: stream.stdout,
      proc: stream.process,
      kill: stream.kill,
      chunks: [],
      size: 0,
      ended: false,
      killed: false,
      exitCode: null,
      framesSent: 0,
      startOffset: src.isLive ? 0 : startAt,
      isLive: src.isLive,
      stdoutPaused: false,
      needsRestart: false,
      recoverCount,
      input: src.input,
    };
    this.session = sess;
    this._isStreaming = src.isLive;
    if (src.isLive && recoverCount === 0) {
      this.streamStartTime = Date.now();
      if (item.source === 'radio') this.startIcyPolling(src.input);
    }

    sess.stdout.on('data', (chunk: Buffer) => {
      if (sess !== this.session || sess.killed) return;
      sess.chunks.push(chunk);
      sess.size += chunk.length;
      // Backpressure: never decode more than ~10 s ahead
      if (!sess.stdoutPaused && sess.size > HIGH_WATER) {
        sess.stdoutPaused = true;
        sess.stdout.pause();
      }
    });
    sess.proc.on('close', (code) => {
      if (sess.killed) return;
      sess.ended = true;
      sess.exitCode = code;
    });
    sess.proc.on('error', (err) => {
      if (sess.killed) return;
      sess.ended = true;
      sess.exitCode = -1;
      this.emit('error', err);
    });

    // Wait for the first buffer so we can report errors (dead link, 403…) to the caller
    await this.waitForBuffer(sess, viaYtDlp ? 30_000 : 15_000);
    if (sess !== this.session) return;
    if (sess.size === 0 && sess.ended) {
      const detail = sess.getError().split('\n').filter(Boolean).slice(-2).join(' | ');
      if (!viaYtDlp && item.sourceUrl && !src.isLive) {
        // Direct URL refused (YouTube PO token, expired signature, missing headers…) → retry through yt-dlp
        console.warn(`[VoiceBot ${this.config.id}] Direct stream failed (${detail || 'no output'}) — retrying via yt-dlp pipe`);
        this.pipeModeItems.add(item);
        return this.startSession(item, startAt, token, recoverCount);
      }
      console.error(`[VoiceBot ${this.config.id}] Could not decode "${item.title}": ${detail}`);
      throw new Error(sess.exitCode === 0 ? 'Track is empty' : `Could not decode audio stream${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    if (this._status === 'playing') this.startTickLoop(sess);
  }

  private waitForBuffer(sess: PlaybackSession, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (sess !== this.session || sess.killed) return resolve();
        if (sess.size >= PREBUFFER || sess.ended || Date.now() - started > timeoutMs) return resolve();
        setTimeout(check, 20);
      };
      check();
    });
  }

  private startTickLoop(sess: PlaybackSession): void {
    const epoch = ++this.loopEpoch;
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    let nextDue = performance.now();

    const tick = () => {
      if (epoch !== this.loopEpoch || sess !== this.session) return;

      const now = performance.now();
      if (now < nextDue) {
        this.playbackTimer = setTimeout(tick, Math.max(1, nextDue - now));
        return;
      }
      // Fell behind (GC pause, CPU spike): resync instead of bursting frames
      if (now - nextDue >= FRAME_MS * 5) nextDue = now;

      const frame = this.takeFrame(sess);
      if (frame) {
        const opusFrame = this.pipeline.encodeFrame(frame, this.config.volume);
        this.sendVoiceFrame(opusFrame);
        sess.framesSent++;
      } else if (sess.ended) {
        this.onSessionEnd(sess);
        return;
      }
      // else: buffer underrun – send nothing this slot (network hiccup)

      if (sess.stdoutPaused && sess.size < LOW_WATER) {
        sess.stdoutPaused = false;
        sess.stdout.resume();
      }
      if ((sess.framesSent & 0xff) === 0) this.maybePrefetch(sess);

      nextDue += FRAME_MS;
      const delay = nextDue - performance.now();
      if (delay > 2) this.playbackTimer = setTimeout(tick, delay);
      else setImmediate(tick);
    };

    this.playbackTimer = setTimeout(tick, 0);
  }

  private takeFrame(sess: PlaybackSession): Buffer | null {
    const n = BYTES_PER_FRAME;
    if (sess.size < n) {
      if (!sess.ended || sess.size === 0) return null;
      // Last partial frame – pad with silence
      const out = Buffer.alloc(n, 0);
      let off = 0;
      for (const c of sess.chunks) { c.copy(out, off); off += c.length; }
      sess.chunks = [];
      sess.size = 0;
      return out;
    }

    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = sess.chunks[0];
      const need = n - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        sess.chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        sess.chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    sess.size -= n;
    return out;
  }

  private onSessionEnd(sess: PlaybackSession): void {
    this.client.sendVoiceStop();
    this.clearTimer();
    const item = sess.item;
    const pos = sess.startOffset + (sess.framesSent * FRAME_MS) / 1000;
    const duration = item.duration ?? 0;

    // Network drop / expired CDN token in the middle of a track → resume where we were
    const endedEarly = !sess.isLive && (sess.exitCode !== 0 || (duration > 60 && pos < duration - 15));
    const radioDropped = sess.isLive;
    // A long healthy run resets the retry budget (radio running for days)
    const retries = sess.framesSent > 3000 ? 0 : sess.recoverCount;
    if ((endedEarly || radioDropped) && retries < MAX_RECOVER && (item.sourceUrl || item.streamUrl) && this._status === 'playing') {
      console.warn(`[VoiceBot ${this.config.id}] Stream ended unexpectedly at ${pos.toFixed(1)}s (exit ${sess.exitCode}) — recovering (${retries + 1}/${MAX_RECOVER})`);
      item.resolved = undefined;
      const token = this.playToken;
      setTimeout(() => {
        if (token !== this.playToken || this._status !== 'playing') return;
        this.startSession(item, sess.isLive ? 0 : pos, token, retries + 1)
          .catch((err) => { if (token === this.playToken) this.finishTrack(item, err); });
      }, sess.isLive ? 2000 : 300);
      return;
    }

    this.finishTrack(item);
  }

  private finishTrack(finished: QueueItem, err?: Error): void {
    this.killSession();
    this._nowPlaying = null;
    this._isStreaming = false;
    this._status = 'connected';
    this.emit('statusChange', this._status);
    this.emit('trackEnd', finished);
    if (err) this.emit('trackError', { item: finished, error: err.message });
    this.advance(finished);
  }

  /** Decide what to play after `finished` (repeat, queue, autoplay). */
  private advance(finished: QueueItem | null): void {
    if (this._status !== 'connected') return;
    if (finished && this.queue.repeat === 'track') {
      this.playSafe(finished);
      return;
    }
    const next = this.queue.next();
    if (next) {
      this.playSafe(next);
      return;
    }
    const seed = finished ?? (this.history[0] ? { ...this.history[0], filePath: '' } as QueueItem : null);
    if (this.config.autoplay && seed && seed.source !== 'radio') {
      this.autoplayFrom(seed);
      return;
    }
    this.resetNickname();
    this.emit('queueEnd');
  }

  private autoplayFrom(seed: QueueItem): void {
    const provider: SearchProvider = this.config.defaultSearch ?? (seed.source === 'soundcloud' ? 'soundcloud' : 'youtube');
    const token = this.playToken;
    findRelated({ url: seed.sourceUrl, title: seed.title, artist: seed.artist, source: seed.source }, provider)
      .then((list) => {
        if (token !== this.playToken || this._status !== 'connected') return;
        const recent = new Set(this.history.slice(0, 60).flatMap((h) => [h.id, h.sourceUrl]).filter(Boolean));
        const pick = list.find((t) => !recent.has(t.id) && !recent.has(t.url));
        if (!pick) { this.resetNickname(); this.emit('queueEnd'); return; }
        const item = trackToQueueItem(pick, 'Autoplay');
        this.queue.add(item);
        const next = this.queue.next();
        this.playSafe(next ?? item);
      })
      .catch((err) => {
        console.error(`[VoiceBot ${this.config.id}] Autoplay failed: ${err.message}`);
        this.resetNickname();
      });
  }

  /** Resolve the next track's stream URL shortly before the current one ends (gapless-ish). */
  private maybePrefetch(sess: PlaybackSession): void {
    if (sess.isLive) return;
    const duration = sess.item.duration ?? 0;
    if (!duration) return;
    const pos = sess.startOffset + (sess.framesSent * FRAME_MS) / 1000;
    if (duration - pos > PREFETCH_BEFORE_END_S) return;
    const next = this.queue.repeat === 'track' ? null : this.queue.peekNext();
    if (!next || !next.sourceUrl || next.resolved || (next.filePath && fs.existsSync(next.filePath))) return;
    const key = next.uid || next.id;
    if (this.prefetchFor === key) return;
    this.prefetchFor = key;
    resolveStream(next.sourceUrl)
      .then((r) => {
        next.resolved = { url: r.url, headers: r.headers, isLive: r.isLive, at: r.resolvedAt };
        if (r.info.title) next.title = r.info.title;
        if (r.info.artist) next.artist = r.info.artist;
        if (r.info.duration) next.duration = r.info.duration;
      })
      .catch(() => { /* will be resolved on play */ });
  }

  private pushHistory(item: QueueItem): void {
    const last = this.history[0];
    if (last && last.id === item.id && Date.now() - last.playedAt < 5000) return;
    this.history.unshift({
      id: item.id,
      title: item.title,
      artist: item.artist,
      source: item.source,
      sourceUrl: item.sourceUrl ?? item.streamUrl,
      thumbnail: item.thumbnail,
      duration: item.duration,
      requestedBy: item.requestedBy,
      playedAt: Date.now(),
    });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
  }

  pause(): void {
    if (this._status !== 'playing') return;
    this.clearTimer();
    this.client.sendVoiceStop();
    this._status = 'paused';
    this.emit('statusChange', this._status);

    const sess = this.session;
    if (!sess) return;
    if (sess.isLive) {
      // Live radio cannot be paused – drop the connection, reconnect on resume
      this.detachSession(sess);
      sess.needsRestart = true;
      return;
    }
    this.clearPauseKillTimer();
    this.pauseKillTimer = setTimeout(() => {
      if (this.session === sess && this._status === 'paused') {
        this.detachSession(sess);
        sess.needsRestart = true;
      }
    }, PAUSE_KILL_MS);
  }

  resume(): void {
    if (this._status !== 'paused') return;
    this.clearPauseKillTimer();
    this._autoPaused = false;
    this._status = 'playing';
    this.emit('statusChange', this._status);

    const sess = this.session;
    const item = this._nowPlaying;
    if (!sess || !item) return;
    if (sess.needsRestart) {
      const pos = sess.isLive ? 0 : sess.startOffset + (sess.framesSent * FRAME_MS) / 1000;
      const token = this.playToken;
      this._loading = true;
      this.startSession(item, pos, token, 0)
        .then(() => { this._loading = false; })
        .catch((err) => { this._loading = false; if (token === this.playToken) this.finishTrack(item, err); });
      return;
    }
    this.startTickLoop(sess);
  }

  seek(seconds: number): void {
    if (this._status !== 'playing' && this._status !== 'paused') return;
    const sess = this.session;
    const item = this._nowPlaying;
    if (!sess || !item || sess.isLive) return;
    const duration = item.duration ?? 0;
    const target = Math.max(0, duration > 0 ? Math.min(seconds, duration - 1) : seconds);

    if (this._status === 'paused') {
      // Apply on resume
      this.detachSession(sess);
      sess.chunks = [];
      sess.size = 0;
      sess.framesSent = 0;
      sess.startOffset = target;
      sess.needsRestart = true;
      return;
    }
    this.clearTimer();
    this.client.sendVoiceStop();
    const token = this.playToken;
    this.startSession(item, target, token, 0)
      .catch((err) => { if (token === this.playToken) this.finishTrack(item, err); });
  }

  setVolume(volume: number): void {
    this.config.volume = Math.max(0, Math.min(100, volume));
    this.emit('volumeChange', this.config.volume);
  }

  setAutoplay(enabled: boolean): void {
    this.config.autoplay = enabled;
  }

  skip(): void {
    const cur = this._nowPlaying;
    ++this.playToken;
    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = null;
    this._status = 'connected';
    this.emit('statusChange', this._status);

    const next = this.queue.next();
    if (next) {
      this.playSafe(next);
    } else if (this.config.autoplay && cur && cur.source !== 'radio') {
      this.autoplayFrom(cur);
    } else {
      this.resetNickname();
    }
  }

  previous(): void {
    // Restart current track if we're more than 5 s in (like every music player)
    if (this._nowPlaying && !this._isStreaming && this.position > 5) {
      this.seek(0);
      return;
    }
    ++this.playToken;
    this.stopIcyPolling();
    this.stopPlayback();
    this._nowPlaying = null;
    this._status = 'connected';
    this.emit('statusChange', this._status);

    const prev = this.queue.previous();
    if (prev) {
      this.playSafe(prev);
    } else {
      this.resetNickname();
    }
  }

  stopAudio(): void {
    ++this.playToken;
    this.stopIcyPolling();
    this.stopPlayback();
    this.client.sendVoiceStop();
    this._nowPlaying = null;
    this._autoPaused = false;
    this.resetNickname();
    if (this._status === 'playing' || this._status === 'paused') {
      this._status = 'connected';
      this.emit('statusChange', this._status);
    }
  }

  private sendVoiceFrame(opusFrame: Buffer): void {
    if (process.env.VOICE_DEBUG === '1') {
      const now = performance.now();
      const dt = this.lastVoiceSendAt ? (now - this.lastVoiceSendAt) : 0;
      this.lastVoiceSendAt = now;
      if (!this.statWindowStart) this.statWindowStart = now;
      if (dt > 0) {
        this.statCount++;
        this.statDtSum += dt;
        this.statDtMin = Math.min(this.statDtMin, dt);
        this.statDtMax = Math.max(this.statDtMax, dt);
      }
      if (now - this.statWindowStart >= 1000) {
        const avg = this.statCount ? (this.statDtSum / this.statCount) : 0;
        console.log(
          `[voice] rate=${this.statCount}/s avg=${avg.toFixed(1)}ms min=${this.statDtMin.toFixed(1)} max=${this.statDtMax.toFixed(1)} buffered=${((this.session?.size ?? 0) / BYTES_PER_SEC).toFixed(1)}s`
        );
        this.statWindowStart = now;
        this.statCount = 0;
        this.statDtSum = 0;
        this.statDtMin = Number.POSITIVE_INFINITY;
        this.statDtMax = 0;
      }
    }
    this.client.sendVoice(opusFrame);
  }

  private clearTimer(): void {
    this.loopEpoch++;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  private clearPauseKillTimer(): void {
    if (this.pauseKillTimer) {
      clearTimeout(this.pauseKillTimer);
      this.pauseKillTimer = null;
    }
  }

  /** Kill FFmpeg of a session but keep the session object (position) around */
  private detachSession(sess: PlaybackSession): void {
    sess.killed = true;
    sess.kill();
  }

  private killSession(): void {
    if (this.session) {
      this.detachSession(this.session);
      this.session = null;
    }
  }

  private stopPlayback(): void {
    this.clearTimer();
    this.clearPauseKillTimer();
    this.killSession();
    this._isStreaming = false;
    this._loading = false;
    this.prefetchFor = null;
  }

  // ─── Video Streaming ────────────────────────────────────────

  get videoStreaming(): boolean {
    return this._videoStreaming;
  }

  get videoStreamStatus(): VideoStreamStatus {
    return {
      streaming: this._videoStreaming,
      streamId: this._activeStreamId,
      source: this._videoSource,
      preset: this._videoPreset,
      framerate: this._videoFramerate,
      bitrate: this._videoBitrate,
      startedAt: this._videoStartedAt,
      viewerCount: this._viewers.size,
      viewers: Array.from(this._viewers.values()),
      sidecar: null,
    };
  }

  /** Start video streaming to TS6 via WebRTC */
  async startVideoStream(source: string, preset?: string, framerate?: number, bitrate?: string): Promise<void> {
    if (this._status !== 'connected' && this._status !== 'playing' && this._status !== 'paused') {
      throw new Error('Bot is not connected');
    }
    if (this._videoStreaming) {
      throw new Error('Video stream already active');
    }

    const sidecarBinary = this.config.sidecarBinaryPath || process.env.SIDECAR_BINARY_PATH || 'sidecar';
    const sidecarPort = this.config.sidecarPort || 9800;
    this._videoPreset = preset ?? this.config.streamPreset ?? DEFAULT_PRESET;
    const presetConfig = STREAM_PRESETS[this._videoPreset] || STREAM_PRESETS[DEFAULT_PRESET];
    const effectiveFramerate = framerate && framerate > 0
      ? framerate
      : presetConfig.framerate;
    const effectiveBitrate = bitrate?.trim()
      ? bitrate.trim()
      : presetConfig.bitrate;

    this._videoFramerate = effectiveFramerate;
    this._videoBitrate = effectiveBitrate;

    // Check if sidecar URL is set (Docker mode — sidecar runs as separate container)
    const sidecarUrl = process.env.SIDECAR_URL;

    if (sidecarUrl) {
      // Docker mode: sidecar is an external service, don't spawn it
      this.sidecarHttp = new SidecarClient(sidecarUrl);
    } else {
      // Local mode: spawn sidecar binary
      const sidecarConfig: SidecarConfig = {
        binaryPath: sidecarBinary,
        port: sidecarPort,
        videoBitrate: effectiveBitrate,
        videoResolution: { width: presetConfig.width, height: presetConfig.height },
        videoFramerate: effectiveFramerate,
      };

      this.sidecarProc = new SidecarProcess(sidecarConfig);
      this.sidecarProc.on('exited', (code: number | null) => {
        console.log(`[VoiceBot ${this.config.id}] Sidecar exited (code=${code})`);
        if (this._videoStreaming) {
          this._videoStreaming = false;
          this._activeStreamId = null;
          this._viewers.clear();
          this.emit('videoStreamStopped');
          this.emit('statusChange', this._status);
        }
      });
      try {
        this.sidecarProc.start();
      } catch (err: any) {
        this.sidecarProc = null;
        throw new Error(`Failed to start sidecar: ${err.message}`);
      }
      this.sidecarHttp = new SidecarClient(sidecarPort);
    }

    // Wait for sidecar to be healthy
    await this.sidecarHttp.waitHealthy();
    console.log(`[VoiceBot ${this.config.id}] Sidecar ready`);

    // Setup stream signaling on the TS3 client
    this.signaling = new StreamSignaling(this.client);
    this.setupSignalingListeners();
    this.signaling.registerStreamNotifications();

    // Wait for server to confirm stream
    const streamPromise = new Promise<ActiveStream>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('setupstream timeout')), 10000);
      const handler = (stream: ActiveStream) => {
        if (stream.clid === this.client.getClientId()) {
          clearTimeout(timeout);
          this.signaling!.removeListener('streamStarted', handler);
          resolve(stream);
        }
      };
      this.signaling!.on('streamStarted', handler);
    });

    // Send setupstream command
    this.signaling.sendSetupStream({
      name: `${this.config.nickname} Stream`,
      type: 3,
      bitrate: 4608,
      accessibility: 1,
      mode: 1,
      viewerLimit: 0,
      audio: true,
    });

    const stream = await streamPromise;
    this._activeStreamId = stream.id;
    this._videoStreaming = true;
    this._videoSource = source;
    this._videoStartedAt = Date.now();

    // Resolve YouTube/streaming URLs via yt-dlp, then start ffmpeg
    const resolvedSource = await resolveVideoUrl(source, presetConfig.height);
    await this.sidecarHttp.setSource(
      resolvedSource,
      presetConfig.width,
      presetConfig.height,
      effectiveFramerate,
      effectiveBitrate,
    );

    console.log(`[VoiceBot ${this.config.id}] Video stream started: ${stream.id}, source: ${source}`);
    this.emit('videoStreamStarted', { streamId: stream.id, source, preset: this._videoPreset });
    this.emit('statusChange', this._status);
  }

  /** Stop video streaming */
  async stopVideoStream(): Promise<void> {
    if (!this._videoStreaming) return;

    // Remove all viewers from TS6 stream first
    if (this.signaling && this._activeStreamId) {
      for (const [clid] of this._viewers) {
        this.signaling.sendRemoveClient(clid, this._activeStreamId);
      }
    }

    // Stop ffmpeg and close WebRTC peers
    try { await this.sidecarHttp?.stopSource(); } catch { /* ignore */ }
    for (const [clid] of this._viewers) {
      try { await this.sidecarHttp?.closePeer(String(clid)); } catch { /* ignore */ }
    }
    this._viewers.clear();

    // Stop TS6 stream
    if (this.signaling && this._activeStreamId) {
      console.log(`[VoiceBot ${this.config.id}] Sending stopstream: ${this._activeStreamId}`);
      this.signaling.sendStreamStop(this._activeStreamId);
    }

    // Wait for the stopstream command to be sent and ACKed over UDP
    await new Promise((r) => setTimeout(r, 1000));

    // Stop sidecar process (only in local mode)
    if (this.sidecarProc) {
      await this.sidecarProc.stop();
      this.sidecarProc = null;
    }

    this._activeStreamId = null;
    this._videoSource = null;
    this._videoStreaming = false;
    this._videoStartedAt = null;
    this.signaling = null;

    console.log(`[VoiceBot ${this.config.id}] Video stream stopped`);
    this.emit('videoStreamStopped');
    this.emit('statusChange', this._status);
  }

  /** Change video source while streaming */
  async setVideoSource(source: string): Promise<void> {
    if (!this._videoStreaming || !this.sidecarHttp) {
      throw new Error('No active video stream');
    }
    this._videoSource = source;
    const currentPreset = STREAM_PRESETS[this._videoPreset] || STREAM_PRESETS[DEFAULT_PRESET];
    const resolvedSource = await resolveVideoUrl(source, currentPreset.height);

    await this.sidecarHttp.setSource(
      resolvedSource,
      currentPreset.width,
      currentPreset.height,
      this._videoFramerate,
      this._videoBitrate,
    );
    console.log(`[VoiceBot ${this.config.id}] Video source changed: ${source}`);
    this.emit('videoSourceChanged', source);
  }

  /** Kick a viewer from the video stream */
  async kickVideoViewer(clid: number): Promise<void> {
    if (!this._videoStreaming || !this.signaling || !this._activeStreamId) {
      throw new Error('No active video stream');
    }
    try { await this.sidecarHttp?.closePeer(String(clid)); } catch { /* ignore */ }
    this.signaling.sendRemoveClient(clid, this._activeStreamId);
    this._viewers.delete(clid);
    this.emit('videoViewerLeft', clid);
  }

  /** Get WebRTC offer for WebUI preview player */
  async getWebRtcOffer(): Promise<{ sdp: string } | null> {
    if (!this._videoStreaming || !this.sidecarHttp) return null;
    return this.sidecarHttp.createPeer('webui-preview');
  }

  /** Set WebRTC answer from WebUI preview player */
  async setWebRtcAnswer(sdp: string): Promise<void> {
    if (!this.sidecarHttp) throw new Error('No sidecar');
    await this.sidecarHttp.setAnswer('webui-preview', sdp);
  }

  /** Add ICE candidate from WebUI preview player */
  async addWebRtcIceCandidate(candidate: string, sdpMid: string, sdpMLineIndex: number): Promise<void> {
    if (!this.sidecarHttp) throw new Error('No sidecar');
    await this.sidecarHttp.addIceCandidate('webui-preview', candidate, sdpMid, sdpMLineIndex);
  }

  private setupSignalingListeners(): void {
    if (!this.signaling) return;

    this.signaling.on('signalingMessage', (msg: SignalingMessage) => {
      this.handleSignalingMessage(msg);
    });

    this.signaling.on('joinStreamRequest', (params: Record<string, string>) => {
      const viewerClid = parseInt(params.clid) || 0;
      const streamId = params.id || this._activeStreamId;
      if (!streamId || !viewerClid) return;
      console.log(`[VoiceBot ${this.config.id}] Viewer join request: clid=${viewerClid}`);
      this.handleViewerJoin(viewerClid, streamId);
    });

    this.signaling.on('streamClientLeft', (params: Record<string, string>) => {
      const clid = parseInt(params.clid) || 0;
      if (this._viewers.has(clid)) {
        console.log(`[VoiceBot ${this.config.id}] Viewer left: clid=${clid}`);
        this.sidecarHttp?.closePeer(String(clid)).catch(() => { });
        this._viewers.delete(clid);
        this.emit('videoViewerLeft', clid);
      }
    });
  }

  private async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    if (!this.sidecarHttp) return;

    switch (msg.type) {
      case 'answer':
        if (msg.sdp && msg.clid) {
          try {
            await this.sidecarHttp.setAnswer(String(msg.clid), msg.sdp);
          } catch (err: any) {
            console.error(`[VoiceBot ${this.config.id}] setAnswer error (clid=${msg.clid}): ${err.message}`);
          }
        }
        break;
      case 'ice_candidate':
        if (msg.candidate && msg.clid) {
          try {
            await this.sidecarHttp.addIceCandidate(
              String(msg.clid),
              msg.candidate,
              msg.sdpMid || '0',
              msg.sdpMlineIndex ?? 0
            );
          } catch (err: any) {
            console.error(`[VoiceBot ${this.config.id}] addIceCandidate error (clid=${msg.clid}): ${err.message}`);
          }
        }
        break;
      case 'reconnect':
        if (msg.clid && this._activeStreamId) {
          console.log(`[VoiceBot ${this.config.id}] Reconnect from clid=${msg.clid}`);
          try { await this.sidecarHttp.closePeer(String(msg.clid)); } catch { /* ignore */ }
          this._viewers.delete(msg.clid);
          await this.handleViewerJoin(msg.clid, this._activeStreamId);
        }
        break;
    }
  }

  private async handleViewerJoin(viewerClid: number, streamId: string): Promise<void> {
    if (!this.sidecarHttp || !this.signaling) return;

    try {
      if (this._viewers.has(viewerClid)) {
        try { await this.sidecarHttp.closePeer(String(viewerClid)); } catch { /* ignore */ }
      }

      const result = await this.sidecarHttp.createPeer(String(viewerClid));

      const viewer: VideoViewerInfo = {
        clid: viewerClid,
        joinedAt: Date.now(),
        iceState: 'new',
      };
      this._viewers.set(viewerClid, viewer);

      this.signaling.sendJoinResponse(viewerClid, streamId, true, result.sdp);
      console.log(`[VoiceBot ${this.config.id}] Viewer accepted: clid=${viewerClid} (${this._viewers.size} total)`);
      this.emit('videoViewerJoined', viewer);
    } catch (err: any) {
      console.error(`[VoiceBot ${this.config.id}] handleViewerJoin error (clid=${viewerClid}): ${err.message}`);
      this._viewers.delete(viewerClid);
    }
  }
}
