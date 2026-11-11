import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { RepeatMode } from './playlist/queue.js';
import { searchTracks, formatDuration, parseTimestamp, isUrl, type SearchProvider, type TrackInfo } from './audio/sources.js';
import { EQ_PRESETS } from './audio/pipeline.js';
import {
  resolveInput, enqueueItems, trackToQueueItem, songToQueueItem, stationToQueueItem,
  saveMusicRequest, type EnqueueMode,
} from './music-service.js';

/**
 * In-channel chat commands for the music bots.
 *
 * The bot listens on its own TS connection (no SSH needed) and answers where the
 * command was written: private chat → private reply, channel chat → channel reply.
 */

type ReplyFn = (msg: string) => void;

interface CommandContext {
  botId: number;
  bot: VoiceBot;
  clid: number;
  nickname: string;
  args: string;
  reply: ReplyFn;
}

type Handler = (ctx: CommandContext) => Promise<void> | void;

const HEAVY_COOLDOWN_MS = 1500;

/** Commands that only DJs may use when "DJ only" is enabled (aliases included) */
const DJ_COMMANDS = new Set([
  'skip', 'next', 'n', 'fs', 'prev', 'back', 'previous', 'pause', 'resume', 'continue', 'stop',
  'vol', 'volume', 'v', 'seek', 'goto', 'ff', 'forward', 'rw', 'rewind', 'clear', 'shuffle', 'mix',
  'loop', 'repeat', 'move', 'mv', 'playnow', 'pnow', 'autoplay', 'ap', 'eq', 'sleep', 'join', 'summon',
  'come', 'stream', 'stopstream', 'radio',
]);
const QUEUE_PAGE = 10;

export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  /** Pending search results per bot+user for "!pick <n>" */
  private pendingSearch = new Map<string, { results: TrackInfo[]; at: number }>();
  private lastHeavy = new Map<string, number>();
  /** Vote-skip state per bot: track uid → voters */
  private votes = new Map<number, { uid: string; voters: Set<number> }>();
  private commands: Map<string, { handler: Handler; heavy?: boolean }>;

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {
    this.commands = new Map();
    const reg = (names: string[], handler: Handler, heavy = false) => {
      for (const n of names) this.commands.set(n, { handler, heavy });
    };

    reg(['play', 'p', 'add'], (c) => this.cmdPlay(c, 'queue'), true);
    reg(['playnow', 'pnow'], (c) => this.cmdPlay(c, 'now'), true);
    reg(['playnext', 'pn'], (c) => this.cmdPlay(c, 'next'), true);
    reg(['sc', 'soundcloud'], (c) => this.cmdProviderPlay(c, 'soundcloud'), true);
    reg(['yt', 'youtube'], (c) => this.cmdProviderPlay(c, 'youtube'), true);
    reg(['search', 'find'], (c) => this.cmdSearch(c), true);
    reg(['pick', 'choose'], (c) => this.cmdPick(c), true);
    reg(['queue', 'q', 'list'], (c) => this.cmdQueue(c));
    reg(['remove', 'rm', 'del'], (c) => this.cmdRemove(c));
    reg(['move', 'mv'], (c) => this.cmdMove(c));
    reg(['clear'], (c) => this.cmdClear(c));
    reg(['shuffle', 'mix'], (c) => this.cmdShuffle(c));
    reg(['loop', 'repeat'], (c) => this.cmdLoop(c));
    reg(['skip', 'next', 'n', 'fs'], (c) => this.cmdSkip(c));
    reg(['prev', 'back', 'previous'], (c) => this.cmdPrev(c));
    reg(['pause'], (c) => this.cmdPause(c));
    reg(['resume', 'continue'], (c) => this.cmdResume(c));
    reg(['stop'], (c) => this.cmdStop(c));
    reg(['vol', 'volume', 'v'], (c) => this.cmdVolume(c));
    reg(['seek', 'goto'], (c) => this.cmdSeek(c));
    reg(['ff', 'forward'], (c) => this.cmdSeekRel(c, +1));
    reg(['rw', 'rewind'], (c) => this.cmdSeekRel(c, -1));
    reg(['np', 'nowplaying', 'song', 'current'], (c) => this.cmdNowPlaying(c));
    reg(['history', 'last'], (c) => this.cmdHistory(c));
    reg(['autoplay', 'ap'], (c) => this.cmdAutoplay(c));
    reg(['radio'], (c) => this.cmdRadio(c), true);
    reg(['playlist', 'pl'], (c) => this.cmdPlaylist(c), true);
    reg(['join', 'summon', 'come'], (c) => this.cmdJoin(c));
    reg(['stream'], (c) => this.cmdStream(c), true);
    reg(['stopstream'], (c) => this.cmdStopStream(c));
    reg(['viewers'], (c) => this.cmdViewers(c));
    reg(['voteskip', 'vs'], (c) => this.cmdVoteSkip(c));
    reg(['save', 'fav', 'like'], (c) => this.cmdSave(c));
    reg(['top', 'charts'], (c) => this.cmdTop(c));
    reg(['eq', 'equalizer'], (c) => this.cmdEq(c));
    reg(['sleep', 'timer'], (c) => this.cmdSleep(c));
    reg(['dj'], (c) => this.cmdDj(c));
    reg(['help', 'commands', 'h'], (c) => this.cmdHelp(c));
  }

  /**
   * Register text message listener on a VoiceBot instance.
   * Called by VoiceBotManager whenever a bot is created/started.
   */
  registerBot(botId: number, bot: VoiceBot): void {
    if (this.registeredBots.has(botId)) return;
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      this.onTextMessage(botId, bot, data).catch((err) => {
        console.error(`[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`);
      });
    });

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
  }

  private async onTextMessage(botId: number, bot: VoiceBot, data: Record<string, string>): Promise<void> {
    const prefix = bot.currentConfig.commandPrefix || '!';
    const msg = this.stripBbcode(data.msg || '').trim();
    if (!msg.startsWith(prefix)) return;

    const body = msg.substring(prefix.length);
    const space = body.search(/\s/);
    const command = (space < 0 ? body : body.substring(0, space)).toLowerCase();
    const entry = this.commands.get(command);
    if (!entry) return;

    const args = space < 0 ? '' : body.substring(space + 1).trim();
    const clid = parseInt(data.invokerid || '0');
    if (!clid || clid === bot.ts3ClientId) return; // ignore ourselves

    const nickname = data.invokername || bot.getClientNickname(clid) || `#${clid}`;
    const targetmode = parseInt(data.targetmode || '1');
    const reply: ReplyFn = (text) => {
      try {
        const chunks = this.splitMessage(text);
        for (const c of chunks) {
          if (targetmode === 2) bot.sendChannelMessage(c);
          else bot.sendTextMessage(clid, c);
        }
      } catch (err: any) {
        console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
      }
    };

    if (entry.heavy) {
      const key = `${botId}:${clid}`;
      const last = this.lastHeavy.get(key) ?? 0;
      if (Date.now() - last < HEAVY_COOLDOWN_MS) return;
      this.lastHeavy.set(key, Date.now());
    }

    console.log(`[MusicCmd] Bot ${botId}: ${prefix}${command} ${args} (from ${nickname})`);

    if (bot.currentConfig.djOnly && DJ_COMMANDS.has(command) && !bot.isDj(clid)) {
      const isSkip = ['skip', 'next', 'n', 'fs'].includes(command);
      reply(isSkip ? `Only DJs can skip directly – use [b]${prefix}voteskip[/b].` : `🎧 Only DJs can use ${prefix}${command}.`);
      return;
    }

    try {
      await entry.handler({ botId, bot, clid, nickname, args, reply });
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling ${prefix}${command}: ${err.message}`);
      reply(`⚠ ${err.message}`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private stripBbcode(s: string): string {
    // TS wraps pasted links in [URL]...[/URL]
    return s.replace(/\[url=([^\]]+)\][^\[]*\[\/url\]/gi, '$1').replace(/\[\/?url\]/gi, '');
  }

  private splitMessage(text: string, max = 900): string[] {
    if (text.length <= max) return [text];
    const out: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; }
      else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) out.push(cur);
    return out;
  }

  private label(t: { title: string; artist?: string }): string {
    return t.artist ? `${t.artist} – ${t.title}` : t.title;
  }

  private progressBar(pos: number, dur: number, width = 18): string {
    if (!dur) return '';
    const filled = Math.max(0, Math.min(width, Math.round((pos / dur) * width)));
    return '━'.repeat(filled) + '●' + '─'.repeat(Math.max(0, width - filled));
  }

  private provider(bot: VoiceBot): SearchProvider {
    return bot.currentConfig.defaultSearch === 'soundcloud' ? 'soundcloud' : 'youtube';
  }

  private ensureConnected(bot: VoiceBot): void {
    if (bot.status === 'stopped' || bot.status === 'starting' || bot.status === 'error') {
      throw new Error('Bot is not connected.');
    }
  }

  private upcomingIndex(bot: VoiceBot, n: number): number {
    // n is 1-based position in the "up next" list
    const base = bot.queue.index >= 0 ? bot.queue.index : bot.queue.length - bot.queue.upcomingCount - 1;
    return base + n;
  }

  /** Remaining queue slots for a user (Infinity = unlimited) */
  private slotsLeft(ctx: CommandContext): number {
    const max = ctx.bot.currentConfig.maxQueuePerUser ?? 0;
    if (!max || (ctx.bot.currentConfig.djGroupIds?.length && ctx.bot.isDj(ctx.clid))) return Infinity;
    const mine = ctx.bot.queue.getUpcoming(1000).filter((t) => t.requestedBy === ctx.nickname).length;
    return Math.max(0, max - mine);
  }

  private async enqueueAndReply(ctx: CommandContext, input: string, mode: EnqueueMode, provider: SearchProvider): Promise<void> {
    const { bot, reply, nickname } = ctx;
    this.ensureConnected(bot);
    const slots = this.slotsLeft(ctx);
    if (slots <= 0) {
      reply(`⛔ You already have ${bot.currentConfig.maxQueuePerUser} track(s) in the queue – wait until one has played.`);
      return;
    }
    const resolved = await resolveInput(input, { provider, requestedBy: nickname });
    if (resolved.items.length > slots) {
      reply(`Only ${slots} more track(s) allowed for you – adding the first ${slots}.`);
      resolved.items = resolved.items.slice(0, slots);
    }
    const { started } = await enqueueItems(bot, resolved.items, mode);
    for (const it of resolved.items.slice(0, 50)) saveMusicRequest(this.prisma, bot.currentConfig.serverConfigId, it);

    const first = resolved.items[0];
    if (resolved.items.length > 1) {
      reply(`➕ [b]${resolved.items.length}[/b] tracks${resolved.playlistTitle ? ` from [b]${resolved.playlistTitle}[/b]` : ''} added.${started ? ` Now playing: ${this.label(first)}` : ''}`);
    } else if (started) {
      if (!bot.currentConfig.announce) reply(`▶ Now playing: [b]${this.label(first)}[/b] [${formatDuration(first.duration)}]`);
    } else {
      const where = mode === 'next' ? 'next' : `#${bot.queue.upcomingCount}`;
      reply(`➕ Queued (${where}): [b]${this.label(first)}[/b] [${formatDuration(first.duration)}]`);
    }
  }

  // ─── Playback commands ─────────────────────────────────────

  private async cmdPlay(ctx: CommandContext, mode: EnqueueMode): Promise<void> {
    const { bot, args, reply } = ctx;
    if (!args) {
      if (bot.status === 'paused') { bot.resume(); reply('▶ Resumed.'); return; }
      reply(`Usage: [b]!play <link or search>[/b] — YouTube, SoundCloud, Bandcamp, Mixcloud, Spotify links or text.`);
      return;
    }
    // "!play 2" right after a search = pick result #2
    if (/^\d{1,2}$/.test(args) && this.pendingSearch.has(`${ctx.botId}:${ctx.clid}`)) {
      await this.pickResult(ctx, parseInt(args), mode);
      return;
    }
    if (!isUrl(args)) reply(`🔎 Searching ${this.provider(bot) === 'soundcloud' ? 'SoundCloud' : 'YouTube'}…`);
    await this.enqueueAndReply(ctx, args, mode, this.provider(bot));
  }

  private async cmdProviderPlay(ctx: CommandContext, provider: SearchProvider): Promise<void> {
    if (!ctx.args) {
      ctx.reply(`Usage: [b]!${provider === 'soundcloud' ? 'sc' : 'yt'} <search or link>[/b]`);
      return;
    }
    await this.enqueueAndReply(ctx, ctx.args, 'queue', provider);
  }

  private async cmdSearch(ctx: CommandContext): Promise<void> {
    const { bot, reply } = ctx;
    let args = ctx.args;
    let provider = this.provider(bot);
    const m = args.match(/^(sc|soundcloud|yt|youtube)\s+(.+)$/i);
    if (m) {
      provider = m[1].toLowerCase().startsWith('s') ? 'soundcloud' : 'youtube';
      args = m[2];
    }
    if (!args) { reply('Usage: [b]!search [sc|yt] <text>[/b], then [b]!pick <n>[/b]'); return; }

    const results = await searchTracks(args, provider, 8);
    if (results.length === 0) { reply(`No results for "${args}".`); return; }
    this.pendingSearch.set(`${ctx.botId}:${ctx.clid}`, { results, at: Date.now() });

    const lines = results.map((r, i) => `[b]${i + 1}.[/b] ${this.label(r)} [${formatDuration(r.duration)}]`);
    reply(`${provider === 'soundcloud' ? 'SoundCloud' : 'YouTube'} results:\n${lines.join('\n')}\n→ [b]!pick <n>[/b]`);
  }

  private async cmdPick(ctx: CommandContext): Promise<void> {
    const n = parseInt(ctx.args);
    if (isNaN(n)) { ctx.reply('Usage: [b]!pick <number>[/b]'); return; }
    await this.pickResult(ctx, n, 'queue');
  }

  private async pickResult(ctx: CommandContext, n: number, mode: EnqueueMode): Promise<void> {
    const key = `${ctx.botId}:${ctx.clid}`;
    const pending = this.pendingSearch.get(key);
    if (!pending || Date.now() - pending.at > 10 * 60_000) {
      this.pendingSearch.delete(key);
      ctx.reply('No recent search. Use [b]!search <text>[/b] first.');
      return;
    }
    const pick = pending.results[n - 1];
    if (!pick) { ctx.reply(`Pick a number between 1 and ${pending.results.length}.`); return; }
    this.pendingSearch.delete(key);
    this.ensureConnected(ctx.bot);
    if (this.slotsLeft(ctx) <= 0) {
      ctx.reply(`⛔ You already have ${ctx.bot.currentConfig.maxQueuePerUser} track(s) in the queue.`);
      return;
    }
    const item = trackToQueueItem(pick, ctx.nickname);
    const { started } = await enqueueItems(ctx.bot, [item], mode);
    saveMusicRequest(this.prisma, ctx.bot.currentConfig.serverConfigId, item);
    if (!started) ctx.reply(`➕ Queued: [b]${this.label(item)}[/b]`);
    else if (!ctx.bot.currentConfig.announce) ctx.reply(`▶ Now playing: [b]${this.label(item)}[/b]`);
  }

  private cmdSkip(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const cur = bot.nowPlaying;
    if (!cur && bot.queue.upcomingCount === 0) { reply('Nothing to skip.'); return; }
    const n = Math.max(1, Math.min(50, parseInt(ctx.args) || 1));
    // "!skip 3" drops the next 2 upcoming tracks first
    for (let i = 1; i < n && bot.queue.upcomingCount > 0; i++) bot.queue.removeAt(this.upcomingIndex(bot, 1));
    bot.skip();
    const next = bot.queue.current;
    reply(next ? `⏭ Skipped. Up now: [b]${this.label(next)}[/b]` : bot.currentConfig.autoplay ? '⏭ Skipped — autoplay is picking something…' : '⏭ Skipped. Queue is empty.');
  }

  private cmdPrev(ctx: CommandContext): void {
    ctx.bot.previous();
    ctx.reply('⏮ Back.');
  }

  private cmdPause(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    if (bot.status === 'paused') { bot.resume(); reply('▶ Resumed.'); }
    else if (bot.status === 'playing') { bot.pause(); reply('⏸ Paused.'); }
    else reply('Nothing is playing.');
  }

  private cmdResume(ctx: CommandContext): void {
    if (ctx.bot.status !== 'paused') { ctx.reply('Not paused.'); return; }
    ctx.bot.resume();
    ctx.reply('▶ Resumed.');
  }

  private cmdStop(ctx: CommandContext): void {
    ctx.bot.stopAudio();
    ctx.reply('⏹ Playback stopped.');
  }

  private async cmdVolume(ctx: CommandContext): Promise<void> {
    const { bot, args, reply } = ctx;
    const current = bot.currentConfig.volume;
    if (!args) { reply(`🔊 Volume: [b]${current}%[/b]`); return; }
    const rel = args.match(/^([+-])\s*(\d+)$/);
    const vol = rel ? current + (rel[1] === '+' ? 1 : -1) * parseInt(rel[2]) : parseInt(args);
    if (isNaN(vol)) { reply('Usage: [b]!vol <0-100>[/b] or [b]!vol +10[/b]'); return; }
    const clamped = Math.max(0, Math.min(100, vol));
    bot.setVolume(clamped);
    await this.prisma.musicBot.update({ where: { id: ctx.botId }, data: { volume: clamped } }).catch(() => { });
    reply(`🔊 Volume set to [b]${clamped}%[/b].`);
  }

  private cmdSeek(ctx: CommandContext): void {
    const { bot, args, reply } = ctx;
    if (!bot.nowPlaying) { reply('Nothing is playing.'); return; }
    if (bot.isStreaming) { reply('Cannot seek in a live stream.'); return; }
    const rel = args.match(/^([+-])(.+)$/);
    if (rel) { this.cmdSeekRel({ ...ctx, args: rel[2] }, rel[1] === '+' ? 1 : -1); return; }
    const t = parseTimestamp(args);
    if (t === null) { reply('Usage: [b]!seek 1:30[/b] or [b]!seek +30[/b]'); return; }
    bot.seek(t);
    reply(`⏩ Jumped to [b]${formatDuration(t)}[/b].`);
  }

  private cmdSeekRel(ctx: CommandContext, dir: 1 | -1): void {
    const { bot, reply } = ctx;
    if (!bot.nowPlaying || bot.isStreaming) { reply('Nothing seekable is playing.'); return; }
    const delta = parseTimestamp(ctx.args || '15') ?? 15;
    const target = Math.max(0, bot.position + dir * delta);
    bot.seek(target);
    reply(`${dir > 0 ? '⏩' : '⏪'} ${formatDuration(target)}`);
  }

  private cmdNowPlaying(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const np = bot.nowPlaying;
    if (!np) { reply('Nothing is playing.'); return; }
    const prog = bot.playbackProgress;
    const link = np.sourceUrl ? ` · [url=${np.sourceUrl}]link[/url]` : '';
    const who = np.requestedBy ? `\nRequested by ${np.requestedBy}` : '';
    if (bot.isStreaming) {
      reply(`📻 [b]${this.label(np)}[/b] · LIVE ${formatDuration(prog?.position)}${who}`);
      return;
    }
    const pos = prog?.position ?? 0;
    const dur = prog?.duration ?? 0;
    reply(`▶ [b]${this.label(np)}[/b]${link}\n${formatDuration(pos)} ${this.progressBar(pos, dur)} ${formatDuration(dur)}${bot.status === 'paused' ? ' (paused)' : ''}${who}`);
  }

  private cmdHistory(ctx: CommandContext): void {
    const h = ctx.bot.history.slice(0, 10);
    if (h.length === 0) { ctx.reply('Nothing played yet.'); return; }
    ctx.reply('Recently played:\n' + h.map((e, i) => `${i + 1}. ${this.label(e)}`).join('\n'));
  }

  private async cmdAutoplay(ctx: CommandContext): Promise<void> {
    const { bot, args, reply } = ctx;
    const a = args.toLowerCase();
    const enabled = a === 'on' || a === '1' || a === 'true' ? true : a === 'off' || a === '0' || a === 'false' ? false : !bot.currentConfig.autoplay;
    bot.setAutoplay(enabled);
    await this.prisma.musicBot.update({ where: { id: ctx.botId }, data: { autoplay: enabled } as any }).catch(() => { });
    reply(`♾ Autoplay is now [b]${enabled ? 'on' : 'off'}[/b]${enabled ? ' — related tracks keep playing when the queue ends.' : '.'}`);
  }

  // ─── Queue commands ────────────────────────────────────────

  private cmdQueue(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const sub = ctx.args.toLowerCase();
    if (sub === 'clear') { this.cmdClear(ctx); return; }
    if (sub === 'shuffle') { this.cmdShuffle(ctx); return; }

    const page = Math.max(1, parseInt(ctx.args) || 1);
    const upcoming = bot.queue.getUpcoming(500);
    const np = bot.nowPlaying;
    const lines: string[] = [];
    if (np) lines.push(`▶ [b]${this.label(np)}[/b] [${formatDuration(np.duration)}]`);
    if (upcoming.length === 0) {
      lines.push(bot.currentConfig.autoplay ? 'Up next: (autoplay)' : 'Queue is empty. Add songs with [b]!play[/b].');
      reply(lines.join('\n'));
      return;
    }
    const pages = Math.ceil(upcoming.length / QUEUE_PAGE);
    const p = Math.min(page, pages);
    const slice = upcoming.slice((p - 1) * QUEUE_PAGE, p * QUEUE_PAGE);
    const total = upcoming.reduce((a, t) => a + (t.duration || 0), 0);
    lines.push(`Up next (${upcoming.length} · ${formatDuration(total)}):`);
    slice.forEach((t, i) => {
      const n = (p - 1) * QUEUE_PAGE + i + 1;
      lines.push(`[b]${n}.[/b] ${this.label(t)} [${formatDuration(t.duration)}]${t.requestedBy ? ` · ${t.requestedBy}` : ''}`);
    });
    if (pages > 1) lines.push(`Page ${p}/${pages} — [b]!queue ${p < pages ? p + 1 : 1}[/b]`);
    const flags = [bot.queue.shuffle && 'shuffle', bot.queue.repeat !== 'off' && `loop ${bot.queue.repeat}`, bot.currentConfig.autoplay && 'autoplay'].filter(Boolean);
    if (flags.length) lines.push(`[i]${flags.join(' · ')}[/i]`);
    reply(lines.join('\n'));
  }

  private cmdRemove(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const n = parseInt(ctx.args);
    if (isNaN(n) || n < 1 || n > bot.queue.upcomingCount) {
      reply(`Usage: [b]!remove <1-${bot.queue.upcomingCount}>[/b] (number from !queue)`);
      return;
    }
    const idx = this.upcomingIndex(bot, n);
    const target = bot.queue.getAll()[idx];
    if (bot.currentConfig.djOnly && !bot.isDj(ctx.clid) && target?.requestedBy !== ctx.nickname) {
      reply('You can only remove your own tracks.');
      return;
    }
    const removed = bot.queue.removeAt(idx);
    reply(removed ? `✖ Removed: ${this.label(removed)}` : 'Not found.');
  }

  private cmdMove(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const [a, b] = ctx.args.split(/\s+/).map((x) => parseInt(x));
    const max = bot.queue.upcomingCount;
    if (!a || !b || a > max || b > max) { reply(`Usage: [b]!move <from> <to>[/b] (1-${max})`); return; }
    bot.queue.move(this.upcomingIndex(bot, a), this.upcomingIndex(bot, b));
    reply(`↕ Moved #${a} → #${b}.`);
  }

  private cmdClear(ctx: CommandContext): void {
    const n = ctx.bot.queue.clearUpcoming();
    ctx.reply(`🗑 Cleared ${n} upcoming track${n === 1 ? '' : 's'}.`);
  }

  private cmdShuffle(ctx: CommandContext): void {
    const { bot, args, reply } = ctx;
    const a = args.toLowerCase();
    const enabled = a === 'off' ? false : a === 'on' ? true : !bot.queue.shuffle;
    bot.queue.setShuffle(enabled);
    reply(`🔀 Shuffle [b]${enabled ? 'on' : 'off'}[/b].`);
  }

  private cmdLoop(ctx: CommandContext): void {
    const { bot, args, reply } = ctx;
    const a = args.toLowerCase();
    const modes: RepeatMode[] = ['off', 'track', 'queue'];
    let mode: RepeatMode;
    if (a === 'track' || a === 'song' || a === 'one') mode = 'track';
    else if (a === 'queue' || a === 'all') mode = 'queue';
    else if (a === 'off' || a === 'none') mode = 'off';
    else mode = modes[(modes.indexOf(bot.queue.repeat) + 1) % modes.length];
    bot.queue.setRepeat(mode);
    reply(`🔁 Loop: [b]${mode}[/b]`);
  }

  // ─── Library / radio ───────────────────────────────────────

  private async cmdRadio(ctx: CommandContext): Promise<void> {
    const { bot, args, reply } = ctx;
    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: bot.currentConfig.serverConfigId },
      orderBy: { name: 'asc' },
    });
    if (stations.length === 0) { reply('No radio stations configured.'); return; }

    if (!args) {
      const lines = stations.map((s: any) => `[b][${s.id}][/b] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      reply('Radio stations:\n' + lines.join('\n') + '\n→ [b]!radio <id or name>[/b]');
      return;
    }

    const id = parseInt(args);
    const q = args.toLowerCase();
    const station: any = stations.find((s: any) => s.id === id) || stations.find((s: any) => s.name.toLowerCase().includes(q));
    if (!station) { reply(`Station "${args}" not found. Use [b]!radio[/b] to list stations.`); return; }

    this.ensureConnected(bot);
    await enqueueItems(bot, [stationToQueueItem(station, ctx.nickname)], 'now');
    if (!bot.currentConfig.announce) reply(`📻 Now playing: [b]${station.name}[/b]`);
  }

  private async cmdPlaylist(ctx: CommandContext): Promise<void> {
    const { bot, args, reply } = ctx;
    const playlists = await this.prisma.playlist.findMany({
      include: { _count: { select: { songs: true } } },
      orderBy: { name: 'asc' },
    });
    if (!args) {
      if (playlists.length === 0) { reply('No playlists yet — create one in the web panel.'); return; }
      reply('Playlists:\n' + playlists.map((p: any) => `[b][${p.id}][/b] ${p.name} (${p._count.songs})`).join('\n') + '\n→ [b]!playlist <id or name>[/b]');
      return;
    }
    const id = parseInt(args);
    const q = args.toLowerCase();
    const pl: any = playlists.find((p: any) => p.id === id) || playlists.find((p: any) => p.name.toLowerCase().includes(q));
    if (!pl) { reply(`Playlist "${args}" not found.`); return; }

    const full = await this.prisma.playlist.findUnique({
      where: { id: pl.id },
      include: { songs: { include: { song: true }, orderBy: { position: 'asc' } } },
    });
    const items = (full?.songs ?? []).map((ps: any) => songToQueueItem(ps.song, ctx.nickname));
    if (items.length === 0) { reply('That playlist is empty.'); return; }
    this.ensureConnected(bot);
    const { started } = await enqueueItems(bot, items, 'queue');
    reply(`📂 Loaded [b]${pl.name}[/b] (${items.length} tracks)${started ? ' — playing.' : ' into the queue.'}`);
  }

  private cmdJoin(ctx: CommandContext): void {
    const { bot, clid, reply } = ctx;
    const cid = bot.getClientChannel(clid);
    if (!cid) { reply('I can’t see which channel you are in.'); return; }
    if (cid === bot.channelId) { reply('I’m already here.'); return; }
    bot.moveToChannel(cid);
    reply('👋 On my way.');
  }

  // ─── Community / DJ features ───────────────────────────────

  private cmdVoteSkip(ctx: CommandContext): void {
    const { bot, clid, reply, botId } = ctx;
    const np = bot.nowPlaying;
    if (!np) { reply('Nothing is playing.'); return; }
    // DJs and the requester skip immediately
    if ((bot.currentConfig.djGroupIds?.length && bot.isDj(clid)) || np.requestedBy === ctx.nickname) {
      bot.skip();
      reply('⏭ Skipped.');
      return;
    }
    const key = np.uid || np.id;
    let v = this.votes.get(botId);
    if (!v || v.uid !== key) { v = { uid: key, voters: new Set() }; this.votes.set(botId, v); }
    v.voters.add(clid);
    const listeners = bot.channelListeners.map((l) => l.clid);
    // Only count votes of people who are still in the channel
    const valid = [...v.voters].filter((id) => listeners.includes(id)).length;
    const pct = bot.currentConfig.voteSkipPercent ?? 50;
    const needed = Math.max(1, Math.ceil((listeners.length || 1) * pct / 100));
    if (valid >= needed) {
      this.votes.delete(botId);
      bot.skip();
      bot.sendChannelMessage(`⏭ Vote passed (${valid}/${needed}) – skipped [b]${this.label(np)}[/b].`);
    } else {
      bot.sendChannelMessage(`🗳 ${ctx.nickname} wants to skip – ${valid}/${needed} votes. Type [b]${bot.currentConfig.commandPrefix || '!'}voteskip[/b] to agree.`);
    }
  }

  /** Save the current track into a playlist (default "Favoriten"). Remote tracks are stored as streamed songs. */
  private async cmdSave(ctx: CommandContext): Promise<void> {
    const { bot, reply } = ctx;
    const np = bot.nowPlaying;
    if (!np) { reply('Nothing is playing.'); return; }
    if (np.source === 'radio') { reply('Radio streams cannot be saved.'); return; }
    const serverConfigId = bot.currentConfig.serverConfigId;
    const name = (ctx.args || 'Favoriten').slice(0, 60);

    let song: any = np.source === 'local' && /^\d+$/.test(np.id)
      ? await this.prisma.song.findUnique({ where: { id: parseInt(np.id) } })
      : null;
    if (!song && np.sourceUrl) {
      song = await this.prisma.song.findFirst({ where: { serverConfigId, sourceUrl: np.sourceUrl } });
    }
    if (!song) {
      song = await this.prisma.song.create({
        data: {
          title: np.title.slice(0, 300),
          artist: np.artist ?? null,
          duration: np.duration ?? null,
          filePath: '', // streamed on demand
          source: np.source,
          sourceUrl: np.sourceUrl ?? np.streamUrl ?? null,
          thumbnail: np.thumbnail ?? null,
          serverConfigId,
        } as any,
      });
    }
    let pl: any = await this.prisma.playlist.findFirst({ where: { name } });
    if (!pl) pl = await this.prisma.playlist.create({ data: { name, musicBotId: ctx.botId } });
    const exists = await this.prisma.playlistSong.findFirst({ where: { playlistId: pl.id, songId: song.id } });
    if (exists) { reply(`Already in [b]${name}[/b].`); return; }
    const count = await this.prisma.playlistSong.count({ where: { playlistId: pl.id } });
    await this.prisma.playlistSong.create({ data: { playlistId: pl.id, songId: song.id, position: count } });
    reply(`❤ Saved [b]${this.label(np)}[/b] to [b]${name}[/b] (${count + 1} tracks) – play it with ${bot.currentConfig.commandPrefix || '!'}playlist ${name}`);
  }

  private async cmdTop(ctx: CommandContext): Promise<void> {
    const { bot, reply } = ctx;
    const serverConfigId = bot.currentConfig.serverConfigId;
    if (ctx.args.toLowerCase().startsWith('user')) {
      const rows: any[] = await (this.prisma as any).musicRequest.groupBy({
        by: ['requestedBy'],
        where: { serverConfigId, requestedBy: { not: null } },
        _sum: { playCount: true },
        orderBy: { _sum: { playCount: 'desc' } },
        take: 10,
      });
      if (!rows.length) { reply('No requests yet.'); return; }
      reply('🏆 Top requesters:\n' + rows.map((r, i) => `${i + 1}. ${r.requestedBy} – ${r._sum.playCount} requests`).join('\n'));
      return;
    }
    const rows: any[] = await (this.prisma as any).musicRequest.findMany({
      where: { serverConfigId },
      orderBy: [{ playCount: 'desc' }, { requestedAt: 'desc' }],
      take: 10,
    });
    if (!rows.length) { reply('No requests yet.'); return; }
    reply('🔥 Most requested:\n' + rows.map((r, i) => `${i + 1}. ${r.artist ? `${r.artist} – ` : ''}${r.title} (${r.playCount}×)`).join('\n'));
  }

  private async cmdEq(ctx: CommandContext): Promise<void> {
    const { bot, reply } = ctx;
    const list = Object.entries(EQ_PRESETS).map(([k, v]) => `${k} (${v.label})`).join(' · ');
    const preset = ctx.args.toLowerCase().trim();
    if (!preset) { reply(`🎚 EQ: [b]${bot.eqPreset}[/b]\nPresets: ${list}`); return; }
    if (!EQ_PRESETS[preset]) { reply(`Unknown preset. Available: ${list}`); return; }
    bot.setEq(preset);
    await this.prisma.musicBot.update({ where: { id: ctx.botId }, data: { eqPreset: preset } as any }).catch(() => { });
    reply(`🎚 EQ set to [b]${EQ_PRESETS[preset].label}[/b].`);
  }

  private cmdSleep(ctx: CommandContext): void {
    const { bot, reply } = ctx;
    const a = ctx.args.toLowerCase().trim();
    if (!a) {
      const left = bot.sleepUntil ? Math.ceil((bot.sleepUntil - Date.now()) / 60000) : 0;
      reply(left > 0 ? `💤 Music stops in ${left} min.` : 'No sleep timer. Usage: [b]!sleep 30[/b] (minutes) or [b]!sleep off[/b]');
      return;
    }
    if (a === 'off' || a === '0') { bot.setSleepTimer(0); reply('Sleep timer cancelled.'); return; }
    // "1:30" = 1 h 30 min (parseTimestamp reads it as 1*60+30), otherwise plain minutes
    const minutes = a.includes(':') ? (parseTimestamp(a) ?? 0) : parseInt(a);
    if (!minutes || minutes < 1) { reply('Usage: [b]!sleep 30[/b] (minutes)'); return; }
    bot.setSleepTimer(minutes);
    reply(`💤 Music stops in ${minutes} min.`);
  }

  private cmdDj(ctx: CommandContext): void {
    const { bot, clid, reply } = ctx;
    const cfg = bot.currentConfig;
    const groups = cfg.djGroupIds ?? [];
    if (!groups.length) { reply('No DJ groups configured – everyone can control the bot.'); return; }
    reply(`${bot.isDj(clid) ? '✅ You are a DJ.' : '❌ You are not a DJ.'} DJ groups: ${groups.join(', ')}${cfg.djOnly ? ' · DJ-only mode is on' : ''}`);
  }

  // ─── Video streaming ───────────────────────────────────────

  private async cmdStream(ctx: CommandContext): Promise<void> {
    const { bot, args, reply } = ctx;
    if (!args) { reply('Usage: [b]!stream <url> [preset][/b] — presets: 480p, 720p, 1080p'); return; }
    const [url, preset] = args.split(/\s+/);
    if (!isUrl(url)) { reply('Please provide a valid URL.'); return; }
    if (bot.videoStreaming) {
      await bot.setVideoSource(url);
      reply(`Stream source changed to: ${url}`);
      return;
    }
    reply('Starting video stream…');
    await bot.startVideoStream(url, preset || undefined);
    reply(`Video stream started: ${url}`);
  }

  private async cmdStopStream(ctx: CommandContext): Promise<void> {
    if (!ctx.bot.videoStreaming) { ctx.reply('No active video stream.'); return; }
    await ctx.bot.stopVideoStream();
    ctx.reply('Video stream stopped.');
  }

  private cmdViewers(ctx: CommandContext): void {
    const status = ctx.bot.videoStreamStatus;
    if (!status.streaming) { ctx.reply('No active video stream.'); return; }
    if (status.viewers.length === 0) { ctx.reply('No viewers connected.'); return; }
    const lines = status.viewers.map((v) => `  clid=${v.clid} (${Math.floor((Date.now() - v.joinedAt) / 1000)}s)`);
    ctx.reply(`Viewers (${status.viewerCount}):\n${lines.join('\n')}`);
  }

  // ─── Help ──────────────────────────────────────────────────

  private cmdHelp(ctx: CommandContext): void {
    const p = ctx.bot.currentConfig.commandPrefix || '!';
    ctx.reply([
      '[b]Music bot commands[/b]',
      `${p}play <link|text> · ${p}sc <text> · ${p}yt <text> · ${p}playnext · ${p}playnow`,
      `${p}search [sc|yt] <text> → ${p}pick <n>`,
      `${p}pause · ${p}resume · ${p}skip [n] · ${p}prev · ${p}stop`,
      `${p}np · ${p}queue [page] · ${p}remove <n> · ${p}move <a> <b> · ${p}clear`,
      `${p}shuffle · ${p}loop [off|track|queue] · ${p}autoplay [on|off]`,
      `${p}vol [0-100|+10|-10] · ${p}seek 1:30 · ${p}ff 30 · ${p}rw 10`,
      `${p}radio [id|name] · ${p}playlist [id|name] · ${p}history · ${p}join`,
      `${p}voteskip · ${p}save [playlist] · ${p}top [users] · ${p}eq [preset] · ${p}sleep <min|off> · ${p}dj`,
      `${p}stream <url> · ${p}stopstream · ${p}viewers`,
    ].join('\n'));
  }
}
