import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  MusicBotSummary, PlaybackState, QueueItemInfo, SearchProvider, SongInfo, TrackSearchResult,
  RadioStationInfo, EnqueueMode, PlaylistSummary,
} from '@ts6/common';
import {
  useMusicBots, useMusicBotState, useStartMusicBot, useStopMusicBot, useDeleteMusicBot,
  usePausePlayback, useResumePlayback, useStopPlayback, useSkipTrack, usePreviousTrack, useSeek, useSetVolume,
  useSetShuffle, useSetRepeat, useSetAutoplay, usePlayUrl, useQueueTrack, usePlaySong, useEnqueue,
  useRemoveFromQueue, usePlayFromQueue, useMoveQueueItem, useClearUpcoming, useBotChannels, useMoveBot, useLoadPlaylist,
} from '@/hooks/use-music-bots';
import { useSongs, useTrackSearch, useDownloadTrack } from '@/hooks/use-music-library';
import { useRadioStations, usePlayRadio } from '@/hooks/use-radio-stations';
import { usePlaylists } from '@/hooks/use-playlists';
import { musicBotsApi } from '@/api/music.api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Volume1, Plus, Search,
  Loader2, Power, PowerOff, MoreHorizontal, Pencil, Trash2, Link2, ListPlus, ListStart, Download, X,
  ChevronUp, ChevronDown, Infinity as InfinityIcon, Users, Hash, Radio, Library, Disc3, History, Square, ListMusic, Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SourceIcon, SoundCloudIcon } from './SourceIcon';
import { BotFormDialog } from './BotFormDialog';
import { formatTime, isUrl, totalDuration } from './format';

// ─── Artwork ────────────────────────────────────────────────────────────────

function Artwork({ src, spinning, className, rounded = 'rounded-xl' }: { src?: string; spinning?: boolean; className?: string; rounded?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return <div className={cn('vinyl aspect-square rounded-full', spinning ? 'spin-slow' : 'spin-slow paused', className)} />;
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('aspect-square object-cover', rounded, className)}
    />
  );
}

const STATUS_DOT: Record<string, string> = {
  stopped: 'bg-muted-foreground/40',
  starting: 'bg-warning animate-pulse',
  connected: 'bg-success',
  playing: 'bg-primary',
  paused: 'bg-warning',
  error: 'bg-destructive',
};

// ─── Bot rail ───────────────────────────────────────────────────────────────

function BotRail({ bots, selectedId, onSelect, onCreate }: {
  bots: MusicBotSummary[]; selectedId: number | null; onSelect: (id: number) => void; onCreate: () => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {bots.map((b) => {
        const active = b.id === selectedId;
        return (
          <button
            key={b.id}
            onClick={() => onSelect(b.id)}
            className={cn(
              'group flex min-w-[200px] max-w-[260px] items-center gap-3 rounded-xl border px-3 py-2 text-left transition-all',
              active ? 'border-primary/50 bg-primary/[0.07] shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]' : 'border-border bg-card hover:border-foreground/20',
            )}
          >
            <div className="relative h-9 w-9 shrink-0">
              <Artwork src={b.nowPlaying?.thumbnail} spinning={b.status === 'playing'} className="h-9 w-9" rounded="rounded-lg" />
              <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', STATUS_DOT[b.status])} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{b.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {b.nowPlaying ? b.nowPlaying.title : b.status === 'stopped' ? 'Offline' : b.channelName ? `#${b.channelName}` : 'Idle'}
              </p>
            </div>
            {b.status === 'playing' && <span className="eq"><span /><span /><span /></span>}
          </button>
        );
      })}
      <button
        onClick={onCreate}
        className="flex min-w-[140px] items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        <Plus className="h-4 w-4" /> New bot
      </button>
    </div>
  );
}

// ─── Now playing hero ───────────────────────────────────────────────────────

function NowPlaying({ bot, state, onEdit, onDelete }: { bot: MusicBotSummary; state?: PlaybackState; onEdit: () => void; onDelete: () => void }) {
  const startBot = useStartMusicBot();
  const stopBot = useStopMusicBot();
  const pause = usePausePlayback();
  const resume = useResumePlayback();
  const stopPlayback = useStopPlayback();
  const skip = useSkipTrack();
  const prev = usePreviousTrack();
  const seek = useSeek();
  const setVolume = useSetVolume();
  const shuffle = useSetShuffle();
  const repeat = useSetRepeat();
  const autoplay = useSetAutoplay();
  const [dragSeek, setDragSeek] = useState<number | null>(null);
  const [dragVol, setDragVol] = useState<number | null>(null);
  const [muteFrom, setMuteFrom] = useState<number | null>(null);
  const [showWidget, setShowWidget] = useState(false);
  const [widget, setWidget] = useState<{ token: string; jsonUrl: string; bbcodeUrl: string } | null>(null);
  const [showChannels, setShowChannels] = useState(false);

  const running = bot.status !== 'stopped' && bot.status !== 'error';
  const np = state?.nowPlaying ?? null;
  const playing = state?.status === 'playing';
  const live = !!state?.isStreaming;
  const duration = state?.duration ?? 0;
  const position = dragSeek ?? state?.position ?? 0;
  const volume = dragVol ?? state?.volume ?? bot.volume;
  const VolIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  const cycleRepeat = () => {
    const modes = ['off', 'queue', 'track'] as const;
    const idx = modes.indexOf((state?.repeat ?? 'off') as any);
    repeat.mutate({ botId: bot.id, mode: modes[(idx + 1) % modes.length] });
  };

  return (
    <Card className="relative overflow-hidden">
      {/* Blurred artwork backdrop */}
      {np?.thumbnail && (
        <div className="pointer-events-none absolute inset-0 opacity-25 dark:opacity-30">
          <img src={np.thumbnail} alt="" referrerPolicy="no-referrer" className="h-full w-full scale-125 object-cover blur-3xl" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-card/60 to-card" />

      <CardContent className="relative p-5 sm:p-6">
        {/* Top bar */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[bot.status])} />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{bot.status}</span>
          {running && state?.channelName && (
            <button onClick={() => setShowChannels(true)} className="flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <Hash className="h-3 w-3" />{state.channelName}
            </button>
          )}
          {running && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                    <Users className="h-3 w-3" />{state?.listeners?.length ?? 0}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {(state?.listeners ?? []).length ? state!.listeners!.map((l) => l.nickname).join(', ') : 'Nobody in the channel'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {state?.autoPaused && <Badge variant="outline" className="border-warning/40 text-[10px] text-warning">auto-paused · channel empty</Badge>}
          <div className="flex-1" />
          {running ? (
            <Button variant="outline" size="sm" className="h-8" onClick={() => stopBot.mutate(bot.id, { onSuccess: () => toast.success('Bot disconnected') })} disabled={stopBot.isPending}>
              <PowerOff className="h-3.5 w-3.5" /> Disconnect
            </Button>
          ) : (
            <Button size="sm" className="h-8" onClick={() => startBot.mutate(bot.id, { onSuccess: () => toast.success('Bot connecting…'), onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to start bot') })} disabled={startBot.isPending}>
              {startBot.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Connect
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onEdit}><Pencil className="mr-2 h-4 w-4" />Settings</DropdownMenuItem>
              {running && <DropdownMenuItem onClick={() => setShowChannels(true)}><Hash className="mr-2 h-4 w-4" />Move to channel…</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => { musicBotsApi.playerWidgetToken(bot.id).then(setWidget); setShowWidget(true); }}><Link2 className="mr-2 h-4 w-4" />Player widget</DropdownMenuItem>
              {np && <DropdownMenuItem onClick={() => stopPlayback.mutate(bot.id)}><Square className="mr-2 h-4 w-4" />Stop audio</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete bot</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
          <div className="relative mx-auto w-40 shrink-0 sm:mx-0 sm:w-44">
            <Artwork src={np?.thumbnail} spinning={playing} className="w-full shadow-2xl shadow-black/40" />
            {state?.loading && (
              <div className="absolute inset-0 grid place-items-center rounded-xl bg-black/50 backdrop-blur-sm">
                <Loader2 className="h-7 w-7 animate-spin text-primary" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            {np ? (
              <>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <SourceIcon source={np.source} />
                  <span className="capitalize">{np.source === 'local' ? 'Library' : np.source}</span>
                  {live && <Badge className="h-4 bg-destructive px-1.5 text-[9px] text-white">LIVE</Badge>}
                  {np.requestedBy && <span>· requested by <span className="text-foreground/80">{np.requestedBy}</span></span>}
                </div>
                <h2 className="line-clamp-2 text-2xl font-bold leading-tight sm:text-3xl" title={np.title}>{np.title}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{np.artist || '—'}</p>
                {np.sourceUrl && (
                  <a href={np.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary">
                    <Link2 className="h-3 w-3" /> open source
                  </a>
                )}
              </>
            ) : (
              <div className="py-4">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{running ? 'Ready' : 'Offline'}</p>
                <h2 className="text-2xl font-bold">{running ? 'Nothing playing' : bot.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {running ? 'Search below, paste a YouTube or SoundCloud link, or type !play in TeamSpeak.' : 'Connect the bot to start playing.'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Progress */}
        <div className="mt-6 space-y-1.5">
          {live ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full w-full animate-pulse bg-gradient-to-r from-primary/20 via-primary to-primary/20" /></div>
              <span className="font-mono-data">{formatTime(position)}</span>
            </div>
          ) : (
            <>
              <Slider
                value={[Math.min(position, duration || 1)]}
                max={duration || 1}
                step={1}
                disabled={!np || !duration}
                onValueChange={([v]) => setDragSeek(v)}
                onValueCommit={([v]) => { seek.mutate({ botId: bot.id, seconds: v }); setTimeout(() => setDragSeek(null), 600); }}
              />
              <div className="flex justify-between font-mono-data text-[11px] text-muted-foreground">
                <span>{formatTime(position)}</span>
                <span>{duration ? `-${formatTime(Math.max(0, duration - position))}` : '--:--'}</span>
              </div>
            </>
          )}
        </div>

        {/* Controls */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className={cn('h-9 w-9', state?.shuffle && 'text-primary')} disabled={!running}
              onClick={() => shuffle.mutate({ botId: bot.id, enabled: !state?.shuffle })} aria-label="Shuffle">
              <Shuffle className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-10 w-10" disabled={!running} onClick={() => prev.mutate(bot.id)} aria-label="Previous">
              <SkipBack className="h-5 w-5" />
            </Button>
            <Button
              size="icon"
              className="h-12 w-12 rounded-full shadow-lg shadow-primary/30"
              disabled={!running || !np}
              onClick={() => (playing ? pause.mutate(bot.id) : resume.mutate(bot.id))}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="!h-5 !w-5" /> : <Play className="!h-5 !w-5 translate-x-px" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-10 w-10" disabled={!running} onClick={() => skip.mutate(bot.id)} aria-label="Next">
              <SkipForward className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className={cn('h-9 w-9', state?.repeat !== 'off' && state?.repeat && 'text-primary')} disabled={!running} onClick={cycleRepeat} aria-label="Repeat">
              {state?.repeat === 'track' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
            </Button>
          </div>

          <label className={cn('flex items-center gap-2 rounded-full border border-border bg-background/40 px-3 py-1.5 text-xs', !running && 'opacity-50')}>
            <InfinityIcon className={cn('h-3.5 w-3.5', state?.autoplay && 'text-primary')} />
            Autoplay
            <Switch className="scale-75" checked={!!state?.autoplay} disabled={!running}
              onCheckedChange={(v) => autoplay.mutate({ botId: bot.id, enabled: v })} />
          </label>

          <div className="ml-auto flex w-full items-center gap-2 sm:w-56">
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (volume > 0) { setMuteFrom(volume); setVolume.mutate({ botId: bot.id, volume: 0 }); }
                else setVolume.mutate({ botId: bot.id, volume: muteFrom || 40 });
              }}
              aria-label="Mute"
            >
              <VolIcon className="h-4 w-4" />
            </button>
            <Slider value={[volume]} max={100} step={1} className="flex-1"
              onValueChange={([v]) => setDragVol(v)}
              onValueCommit={([v]) => { setVolume.mutate({ botId: bot.id, volume: v }); setTimeout(() => setDragVol(null), 600); }} />
            <span className="w-8 text-right font-mono-data text-[11px] text-muted-foreground">{volume}</span>
          </div>
        </div>
      </CardContent>

      <ChannelDialog botId={running ? bot.id : null} open={showChannels} onClose={() => setShowChannels(false)} />

      <Dialog open={showWidget} onOpenChange={setShowWidget}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Player widget</DialogTitle>
            <DialogDescription>Embed in a TeamSpeak channel description or on your website.</DialogDescription>
          </DialogHeader>
          {widget && (
            <div className="space-y-3">
              {[['BBCode (channel description)', widget.bbcodeUrl], ['JSON (websites)', widget.jsonUrl]].map(([label, url]) => (
                <div key={label}>
                  <p className="mb-1 text-[11px] text-muted-foreground">{label}</p>
                  <div className="flex gap-1.5">
                    <Input readOnly className="h-8 font-mono-data text-[11px]" value={url} />
                    <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => { navigator.clipboard.writeText(url); toast.success('Copied'); }}>Copy</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ChannelDialog({ botId, open, onClose }: { botId: number | null; open: boolean; onClose: () => void }) {
  const { data, isLoading } = useBotChannels(botId, open);
  const move = useMoveBot();
  const [filter, setFilter] = useState('');
  const list = (data?.channels ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move bot</DialogTitle><DialogDescription>Pick the channel the bot should join.</DialogDescription></DialogHeader>
        <Input placeholder="Filter channels…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-72 overflow-y-auto">
          {isLoading && <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>}
          {list.map((c) => (
            <button
              key={c.cid}
              onClick={() => botId && move.mutate({ botId, cid: c.cid }, { onSuccess: () => { toast.success(`Moved to ${c.name}`); onClose(); }, onError: () => toast.error('Move failed') })}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', c.cid === data?.current && 'text-primary')}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.name.replace(/\[[a-z]*spacer\d*\]/i, '').trim() || c.name}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Search / add music ─────────────────────────────────────────────────────

type SourceTab = 'youtube' | 'soundcloud' | 'library' | 'radio';

function RowActions({ onNow, onNext, onQueue, onDownload, disabled }: {
  onNow: () => void; onNext?: () => void; onQueue?: () => void; onDownload?: () => void; disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
      <Button size="icon" className="h-8 w-8 rounded-full" onClick={onNow} disabled={disabled} title="Play now"><Play className="h-3.5 w-3.5 translate-x-px" /></Button>
      {onNext && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext} disabled={disabled} title="Play next"><ListStart className="h-4 w-4" /></Button>}
      {onQueue && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onQueue} disabled={disabled} title="Add to queue"><ListPlus className="h-4 w-4" /></Button>}
      {onDownload && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDownload} title="Save to library"><Download className="h-4 w-4" /></Button>}
    </div>
  );
}

function AddMusic({ bot, running }: { bot: MusicBotSummary; running: boolean }) {
  const configId = bot.serverConfigId;
  const [tab, setTab] = useState<SourceTab>(bot.defaultSearch === 'soundcloud' ? 'soundcloud' : 'youtube');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TrackSearchResult[]>([]);
  const [lastQuery, setLastQuery] = useState('');
  const search = useTrackSearch();
  const playUrl = usePlayUrl();
  const queueTrack = useQueueTrack();
  const playSong = usePlaySong();
  const enqueue = useEnqueue();
  const playRadio = usePlayRadio();
  const loadPlaylist = useLoadPlaylist();
  const download = useDownloadTrack();
  const { data: songs } = useSongs(tab === 'library' ? configId : null);
  const { data: stations } = useRadioStations(tab === 'radio' ? configId : null);
  const { data: playlists } = usePlaylists();

  const busy = playUrl.isPending || queueTrack.isPending;
  const urlMode = isUrl(query.trim());

  const err = (e: any, fallback: string) => toast.error(e?.response?.data?.error || fallback);
  const modeLabel = (m: EnqueueMode) => (m === 'now' ? 'Playing' : m === 'next' ? 'Plays next' : 'Added to queue');

  const runSearch = () => {
    const q = query.trim();
    if (!q || urlMode || (tab !== 'youtube' && tab !== 'soundcloud')) return;
    setLastQuery(q);
    search.mutate({ configId, query: q, provider: tab as SearchProvider }, {
      onSuccess: (r) => setResults(Array.isArray(r) ? r : []),
      onError: (e) => err(e, 'Search failed – is yt-dlp up to date?'),
    });
  };

  const addLink = (mode: EnqueueMode) => {
    const url = query.trim();
    const t = toast.loading('Resolving link…');
    playUrl.mutate({ botId: bot.id, url, mode }, {
      onSuccess: (r: any) => {
        toast.success(r.count > 1 ? `${r.count} tracks${r.playlistTitle ? ` from “${r.playlistTitle}”` : ''} added` : `${modeLabel(mode)}: ${r.queueItem?.title ?? 'track'}`, { id: t });
        setQuery('');
      },
      onError: (e) => { toast.dismiss(t); err(e, 'Could not play that link'); },
    });
  };

  const addTrack = (track: TrackSearchResult, mode: EnqueueMode) => {
    queueTrack.mutate({ botId: bot.id, track, mode }, {
      onSuccess: () => toast.success(`${modeLabel(mode)}: ${track.title}`),
      onError: (e) => err(e, 'Failed to add track'),
    });
  };

  const saveTrack = (track: TrackSearchResult) => {
    const t = toast.loading(`Downloading “${track.title}”…`);
    download.mutate({ configId, url: track.url }, {
      onSuccess: () => toast.success('Saved to library', { id: t }),
      onError: (e) => { toast.dismiss(t); err(e, 'Download failed'); },
    });
  };

  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];
  const playlistList = (Array.isArray(playlists) ? playlists : []) as PlaylistSummary[];
  const filteredSongs = query && !urlMode
    ? songList.filter((s) => `${s.title} ${s.artist ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    : songList;

  const tabs: { id: SourceTab; label: string; icon: React.ReactNode }[] = [
    { id: 'youtube', label: 'YouTube', icon: <SourceIcon source="youtube" colored={tab === 'youtube'} /> },
    { id: 'soundcloud', label: 'SoundCloud', icon: <SoundCloudIcon className={cn('h-3.5 w-3.5', tab === 'soundcloud' && 'text-orange-500')} /> },
    { id: 'library', label: 'Library', icon: <Library className="h-3.5 w-3.5" /> },
    { id: 'radio', label: 'Radio', icon: <Radio className="h-3.5 w-3.5" /> },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-muted/50 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setResults([]); }}
              className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        <div className="relative">
          {urlMode ? <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" /> : <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') urlMode ? running && addLink('now') : runSearch(); }}
            placeholder={tab === 'library' ? 'Filter your library…' : tab === 'radio' ? 'Filter stations…' : `Search ${tab === 'soundcloud' ? 'SoundCloud' : 'YouTube'} or paste any link (track, playlist, set, Spotify)…`}
            className="h-11 rounded-xl pl-9 pr-24 text-sm"
          />
          {(tab === 'youtube' || tab === 'soundcloud') && !urlMode && (
            <Button size="sm" className="absolute right-1.5 top-1/2 h-8 -translate-y-1/2" onClick={runSearch} disabled={!query.trim() || search.isPending}>
              {search.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Search'}
            </Button>
          )}
        </div>

        {urlMode && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
            <SourceIcon source={/soundcloud/.test(query) ? 'soundcloud' : /youtu/.test(query) ? 'youtube' : 'url'} className="h-4 w-4" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{query}</p>
            <Button size="sm" className="h-8" onClick={() => addLink('now')} disabled={!running || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Play now
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => addLink('next')} disabled={!running || busy}><ListStart className="h-3.5 w-3.5" /> Next</Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => addLink('queue')} disabled={!running || busy}><ListPlus className="h-3.5 w-3.5" /> Queue</Button>
          </div>
        )}

        {!running && <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">Connect the bot to play music. You can still browse.</p>}

        {/* Results */}
        <div className="-mx-2 max-h-[460px] overflow-y-auto">
          {(tab === 'youtube' || tab === 'soundcloud') && !urlMode && (
            search.isPending ? (
              <div className="space-y-2 px-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : results.length === 0 ? (
              <div className="px-2 py-10 text-center text-sm text-muted-foreground">
                {lastQuery ? `No results for “${lastQuery}”.` : tab === 'soundcloud'
                  ? 'Search tracks, DJ sets and mixes on SoundCloud — or paste a track, set, likes or profile link.'
                  : 'Search YouTube — or paste a video, playlist or YouTube Music link.'}
              </div>
            ) : results.map((r) => (
              <div key={r.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <Artwork src={r.thumbnail} className={cn('h-11 shrink-0', r.source === 'youtube' ? 'aspect-video w-[78px]' : 'w-11')} rounded="rounded-md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={r.title}>{r.title}</p>
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <SourceIcon source={r.source} className="h-3 w-3" />{r.artist || 'Unknown'}
                    <span className="font-mono-data">· {formatTime(r.duration)}</span>
                  </p>
                </div>
                <RowActions disabled={!running || busy}
                  onNow={() => addTrack(r, 'now')} onNext={() => addTrack(r, 'next')} onQueue={() => addTrack(r, 'queue')}
                  onDownload={() => saveTrack(r)} />
              </div>
            ))
          )}

          {tab === 'library' && (
            <>
              {playlistList.length > 0 && !query && (
                <div className="mb-3 flex gap-2 overflow-x-auto px-2 pb-1">
                  {playlistList.map((p) => (
                    <button key={p.id} disabled={!running}
                      onClick={() => loadPlaylist.mutate({ botId: bot.id, playlistId: p.id, clearFirst: false }, { onSuccess: () => toast.success(`Playlist “${p.name}” queued`), onError: (e) => err(e, 'Failed to load playlist') })}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-xs hover:border-primary/40 disabled:opacity-50">
                      <ListMusic className="h-4 w-4 text-primary" />
                      <span><span className="block font-medium">{p.name}</span><span className="text-muted-foreground">{p.songCount} songs</span></span>
                    </button>
                  ))}
                </div>
              )}
              {filteredSongs.length === 0 ? (
                <p className="px-2 py-10 text-center text-sm text-muted-foreground">No songs in the library yet. Use the download button on search results or upload files in the Library tab.</p>
              ) : filteredSongs.map((s) => (
                <div key={s.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                  <Artwork src={s.thumbnail ?? undefined} className="h-10 w-10 shrink-0" rounded="rounded-md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.title}</p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"><SourceIcon source={s.source} className="h-3 w-3" />{s.artist || '—'} <span className="font-mono-data">· {formatTime(s.duration)}</span></p>
                  </div>
                  <RowActions disabled={!running}
                    onNow={() => playSong.mutate({ botId: bot.id, songId: s.id }, { onError: (e) => err(e, 'Failed to play') })}
                    onNext={() => enqueue.mutate({ botId: bot.id, songId: s.id, mode: 'next' }, { onSuccess: () => toast.success('Plays next') })}
                    onQueue={() => enqueue.mutate({ botId: bot.id, songId: s.id, mode: 'queue' }, { onSuccess: () => toast.success('Added to queue') })} />
                </div>
              ))}
            </>
          )}

          {tab === 'radio' && (
            stationList.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted-foreground">No stations yet — add some in the Radio tab.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 px-2 sm:grid-cols-2">
                {stationList.filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase())).map((s) => (
                  <button key={s.id} disabled={!running}
                    onClick={() => playRadio.mutate({ botId: bot.id, stationId: s.id }, { onSuccess: () => toast.success(`Tuned in: ${s.name}`), onError: (e) => err(e, 'Failed to play radio') })}
                    className="group flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2.5 text-left transition-colors hover:border-primary/40 disabled:opacity-50">
                    <div className="grid h-9 w-9 place-items-center rounded-full bg-sky-500/15 text-sky-400"><Radio className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.genre || 'Radio'}</p>
                    </div>
                    <Play className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Queue ──────────────────────────────────────────────────────────────────

function QueuePanel({ bot, state }: { bot: MusicBotSummary; state?: PlaybackState }) {
  const remove = useRemoveFromQueue();
  const playAt = usePlayFromQueue();
  const move = useMoveQueueItem();
  const clear = useClearUpcoming();
  const playUrl = usePlayUrl();
  const [view, setView] = useState<'queue' | 'history'>('queue');

  const queue: QueueItemInfo[] = state?.queue ?? [];
  const cur = state?.currentIndex ?? -1;
  const start = cur >= 0 ? cur + 1 : queue.length - (state?.upcomingCount ?? queue.length);
  const upcoming = useMemo(() => queue.slice(Math.max(0, start)).map((item, i) => ({ item, index: Math.max(0, start) + i })), [queue, start]);
  const history = state?.history ?? [];

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-2">
        {(['queue', 'history'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium', view === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {v === 'queue' ? <ListMusic className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
            {v === 'queue' ? `Up next${upcoming.length ? ` · ${upcoming.length}` : ''}` : 'History'}
          </button>
        ))}
        <div className="flex-1" />
        {view === 'queue' && upcoming.length > 0 && (
          <>
            <span className="font-mono-data text-[11px] text-muted-foreground">{formatTime(totalDuration(upcoming.map((u) => u.item)))}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Clear upcoming" onClick={() => clear.mutate(bot.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
          </>
        )}
      </div>

      <div className="max-h-[720px] min-h-[240px] flex-1 overflow-y-auto p-2">
        {view === 'queue' ? (
          upcoming.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
              <Disc3 className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Queue is empty</p>
              <p className="max-w-[220px] text-xs text-muted-foreground/70">{state?.autoplay ? 'Autoplay will pick related tracks.' : 'Add tracks from the search, or turn on Autoplay.'}</p>
            </div>
          ) : upcoming.map(({ item, index }, i) => (
            <div key={item.uid ?? `${item.id}-${index}`} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted/50">
              <span className="w-5 text-right font-mono-data text-[11px] text-muted-foreground">{i + 1}</span>
              <Artwork src={item.thumbnail} className="h-9 w-9 shrink-0" rounded="rounded-md" />
              <button className="min-w-0 flex-1 text-left" onClick={() => playAt.mutate({ botId: bot.id, index })} title="Play now">
                <p className="truncate text-[13px] font-medium group-hover:text-primary">{item.title}</p>
                <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                  <SourceIcon source={item.source} className="h-2.5 w-2.5" />{item.artist || '—'}
                  {item.requestedBy && <span className="truncate">· {item.requestedBy}</span>}
                </p>
              </button>
              <span className="font-mono-data text-[11px] text-muted-foreground group-hover:hidden">{formatTime(item.duration)}</span>
              <div className="hidden items-center group-hover:flex">
                <button className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" disabled={i === 0}
                  onClick={() => move.mutate({ botId: bot.id, from: index, to: index - 1 })} aria-label="Move up"><ChevronUp className="h-3.5 w-3.5" /></button>
                <button className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" disabled={i === upcoming.length - 1}
                  onClick={() => move.mutate({ botId: bot.id, from: index, to: index + 1 })} aria-label="Move down"><ChevronDown className="h-3.5 w-3.5" /></button>
                <button className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => remove.mutate({ botId: bot.id, index })} aria-label="Remove"><X className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))
        ) : history.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Nothing played yet.</p>
        ) : history.map((h, i) => (
          <div key={`${h.id}-${h.playedAt}-${i}`} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted/50">
            <Artwork src={h.thumbnail} className="h-9 w-9 shrink-0" rounded="rounded-md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{h.title}</p>
              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                <SourceIcon source={h.source} className="h-2.5 w-2.5" />{h.artist || '—'} · {new Date(h.playedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            {h.sourceUrl && h.source !== 'radio' && h.source !== 'local' && (
              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100" title="Add to queue"
                onClick={() => playUrl.mutate({ botId: bot.id, url: h.sourceUrl!, mode: 'queue' }, { onSuccess: () => toast.success('Added to queue') })}>
                <ListPlus className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Commands cheat sheet ───────────────────────────────────────────────────

function CommandHint({ prefix }: { prefix: string }) {
  const cmds = [
    ['play <link|text>', 'play / queue'], ['sc <text>', 'SoundCloud'], ['search <text>', 'then pick <n>'],
    ['skip', 'next track'], ['queue', 'show queue'], ['vol 40', 'volume'], ['seek 1:30', 'jump'],
    ['loop', 'repeat mode'], ['autoplay', 'toggle'], ['join', 'come to my channel'], ['help', 'all commands'],
  ];
  return (
    <Card>
      <CardContent className="p-4">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Terminal className="h-3.5 w-3.5" /> In TeamSpeak chat</p>
        <div className="flex flex-wrap gap-1.5">
          {cmds.map(([c, d]) => (
            <span key={c} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]" title={d}>
              <span className="font-mono-data text-primary">{prefix}{c}</span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function PlayerView() {
  const { data, isLoading } = useMusicBots();
  const deleteBot = useDeleteMusicBot();
  const bots = (Array.isArray(data) ? data : []) as MusicBotSummary[];
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    try { return parseInt(localStorage.getItem('ts6-music-bot') || '') || null; } catch { return null; }
  });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MusicBotSummary | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (bots.length === 0) return;
    if (!selectedId || !bots.some((b) => b.id === selectedId)) {
      const pick = bots.find((b) => b.status === 'playing') ?? bots.find((b) => b.status !== 'stopped') ?? bots[0];
      setSelectedId(pick.id);
    }
  }, [bots, selectedId]);
  useEffect(() => {
    try { if (selectedId) localStorage.setItem('ts6-music-bot', String(selectedId)); } catch { /* ignore */ }
  }, [selectedId]);

  const bot = bots.find((b) => b.id === selectedId) ?? null;
  const running = !!bot && bot.status !== 'stopped' && bot.status !== 'error';
  const { data: state } = useMusicBotState(running ? bot!.id : null) as { data: PlaybackState | undefined };

  if (isLoading) return <div className="h-64 animate-pulse rounded-xl bg-muted/40" />;

  return (
    <div className="space-y-4">
      {bots.length === 0 ? (
        <EmptyState icon={Disc3} title="No music bots yet" description="Create a bot – it joins your TeamSpeak like a normal client and streams YouTube, SoundCloud, radio and your own files." />
      ) : (
        <BotRail bots={bots} selectedId={selectedId} onSelect={setSelectedId} onCreate={() => { setEditing(null); setFormOpen(true); }} />
      )}
      {bots.length === 0 && (
        <div className="flex justify-center"><Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="h-4 w-4" /> Create music bot</Button></div>
      )}

      {bot && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <NowPlaying bot={bot} state={running ? state : undefined} onEdit={() => { setEditing(bot); setFormOpen(true); }} onDelete={() => setDeleteId(bot.id)} />
            <AddMusic bot={bot} running={running} />
          </div>
          <div className="space-y-4">
            <QueuePanel bot={bot} state={running ? state : undefined} />
            <CommandHint prefix={bot.commandPrefix || '!'} />
          </div>
        </div>
      )}

      <BotFormDialog open={formOpen} bot={editing} onClose={() => setFormOpen(false)} />
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete music bot?"
        description="The bot is disconnected and removed permanently."
        onConfirm={() => { if (deleteId) deleteBot.mutate(deleteId, { onSuccess: () => { toast.success('Bot deleted'); setDeleteId(null); setSelectedId(null); } }); }}
        destructive
      />
    </div>
  );
}
