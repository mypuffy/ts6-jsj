import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { musicRequestsApi } from '@/api/music-requests.api';
import { musicBotsApi } from '@/api/music.api';
import {
  useMusicBots, useCreateMusicBot, useUpdateMusicBot, useDeleteMusicBot,
  useStartMusicBot, useStopMusicBot, useMusicBotState,
  usePlaySong, usePlayUrl, usePausePlayback, useResumePlayback, useStopPlayback,
  useSkipTrack, usePreviousTrack, useSeek, useSetVolume,
  useEnqueue, useLoadPlaylist, useRemoveFromQueue, useClearQueue,
  useSetShuffle, useSetRepeat,
  usePlayFromQueue, useMoveQueueItem,
} from '@/hooks/use-music-bots';
import { useSongs, useUploadSong, useDeleteSong, useTrackSearch, useYouTubeDownload, useYouTubeInfo, useYouTubeDownloadBatch } from '@/hooks/use-music-library';
import { useRadioStations, useRadioPresets, useCreateRadioStation, useDeleteRadioStation, usePlayRadio } from '@/hooks/use-radio-stations';
import { usePlaylists, usePlaylist, useCreatePlaylist, useDeletePlaylist, useAddSongToPlaylist, useRemoveSongFromPlaylist } from '@/hooks/use-playlists';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Music, Plus, Trash2, Play, Pause, SkipForward, SkipBack, Square,
  Volume2, VolumeX, Upload, Search, Download, ListMusic, Shuffle,
  Repeat, Repeat1, Power, PowerOff, RefreshCw, Pencil, X, Loader2,
  Youtube, FileAudio, Link, GripVertical, Music2, Radio, Clock,
  Video, Disc3,
} from 'lucide-react';
import { VideoStreamTab } from '@/components/video/VideoStreamTab';
import { PlayerView } from '@/components/music/PlayerView';
import { SourceIcon } from '@/components/music/SourceIcon';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/utils';
import type { MusicBotSummary, SongInfo, TrackSearchResult, PlaylistSummary, PlaylistDetail, YouTubeSearchResult, RadioStationInfo, RadioPreset } from '@ts6/common';

// ─── Helper ──────────────────────────────────────────────────────────────────

function formatTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const statusColors: Record<string, string> = {
  stopped: 'bg-zinc-500',
  starting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  playing: 'bg-emerald-500 animate-pulse',
  paused: 'bg-amber-500',
  error: 'bg-red-500',
};

// ─── Library Tab ─────────────────────────────────────────────────────────────

function LibraryTab() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [libServerId, setLibServerId] = useState<number | null>(selectedConfigId);
  const configId = libServerId || selectedConfigId;

  const { data: songs, isLoading } = useSongs(configId);
  const uploadSong = useUploadSong();
  const deleteSong = useDeleteSong();
  const ytSearch = useTrackSearch();
  const [provider, setProvider] = useState<'youtube' | 'soundcloud'>('youtube');
  const ytDownload = useYouTubeDownload();

  const ytInfo = useYouTubeInfo();
  const ytBatchDownload = useYouTubeDownloadBatch();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [ytResults, setYtResults] = useState<TrackSearchResult[]>([]);
  const [showYt, setShowYt] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [ytUrl, setYtUrl] = useState('');
  const [urlInfo, setUrlInfo] = useState<{ type: 'video' | 'playlist'; title?: string; items: (YouTubeSearchResult & { url?: string; source?: string })[] } | null>(null);
  const [selectedUrlIds, setSelectedUrlIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<string | null>(null);

  const serverList = Array.isArray(servers) ? servers : [];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const filtered = filter
    ? songList.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.artist || '').toLowerCase().includes(filter.toLowerCase()))
    : songList;

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !configId) return;
    Array.from(files).forEach((file) => {
      const formData = new FormData();
      formData.append('file', file);
      uploadSong.mutate({ configId, formData }, {
        onSuccess: () => toast.success(`Uploaded: ${file.name}`),
        onError: () => toast.error(`Failed to upload: ${file.name}`),
      });
    });
    e.target.value = '';
  };

  const handleYtSearch = () => {
    if (!searchQuery.trim() || !configId) return;
    ytSearch.mutate({ configId, query: searchQuery, provider }, {
      onSuccess: (data: any) => {
        setYtResults(Array.isArray(data) ? data : data?.results || []);
        setShowYt(true);
      },
      onError: () => toast.error('Search failed'),
    });
  };

  const handleYtDownload = (url: string) => {
    if (!configId) return;
    const t = toast.loading('Downloading…');
    ytDownload.mutate({ configId, url }, {
      onSuccess: (song: any) => toast.success(`Saved: ${song?.title ?? 'track'}`, { id: t }),
      onError: (e: any) => { toast.dismiss(t); toast.error(e?.response?.data?.error || 'Download failed'); },
    });
  };

  const sourceIcon = (source: string) => <SourceIcon source={source} className="h-3 w-3" />;

  const handleLoadUrl = () => {
    if (!ytUrl.trim() || !configId) return;
    ytInfo.mutate({ configId, url: ytUrl }, {
      onSuccess: (data: any) => {
        setUrlInfo(data);
        if (data.type === 'playlist') {
          setSelectedUrlIds(new Set(data.items.map((i: any) => i.id)));
        }
      },
      onError: () => toast.error('Failed to load URL info'),
    });
  };

  const handleBatchDownload = () => {
    if (!configId || !urlInfo) return;
    const urls = urlInfo.items
      .filter((i) => selectedUrlIds.has(i.id))
      .map((i) => i.url || `https://youtube.com/watch?v=${i.id}`);
    setBatchProgress(`Downloading 0/${urls.length}...`);
    ytBatchDownload.mutate({ configId, urls }, {
      onSuccess: (data: any) => {
        setBatchProgress(null);
        toast.success(`Downloaded ${data.downloaded}/${data.total} songs`);
        if (data.errors?.length) toast.error(`${data.errors.length} failed`);
        setUrlInfo(null);
        setYtUrl('');
      },
      onError: () => { setBatchProgress(null); toast.error('Batch download failed'); },
    });
  };

  const toggleUrlSelect = (id: string) => {
    setSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!configId) {
    return <EmptyState icon={Music} title="Select a server" description="Choose a server to manage its music library." />;
  }

  return (
    <div className="space-y-4">
      {/* Server selector + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setLibServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter songs..."
          className="w-48"
        />
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={handleUpload} />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadSong.isPending}>
          <Upload className="h-4 w-4 mr-1" /> {uploadSong.isPending ? 'Uploading...' : 'Upload'}
        </Button>
      </div>

      {/* YouTube URL / Playlist Paste */}
      <Card className="border-dashed">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Link className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
                placeholder="Paste a YouTube or SoundCloud link (track, playlist, set, likes)…"
                className="pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={handleLoadUrl} disabled={ytInfo.isPending || !ytUrl.trim()}>
              {ytInfo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link className="h-4 w-4 mr-1" />}
              Load
            </Button>
            {urlInfo && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setUrlInfo(null); setYtUrl(''); }}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* URL Info Results */}
          {urlInfo && (
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Badge variant="secondary" className="text-xs">
                  {urlInfo.type === 'playlist' ? `${urlInfo.title ? urlInfo.title + ' · ' : 'Playlist · '}${urlInfo.items.length} tracks` : 'Single track'}
                </Badge>
                {urlInfo.type === 'playlist' && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(new Set(urlInfo.items.map((i) => i.id)))}
                    >
                      Select All
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                      onClick={() => setSelectedUrlIds(new Set())}
                    >
                      Deselect All
                    </Button>
                    <Button variant="default" size="sm" className="h-7 text-xs"
                      onClick={handleBatchDownload}
                      disabled={selectedUrlIds.size === 0 || ytBatchDownload.isPending}
                    >
                      {ytBatchDownload.isPending ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {batchProgress || 'Downloading...'}</>
                      ) : (
                        <><Download className="h-3 w-3 mr-1" /> Download {selectedUrlIds.size} Selected</>
                      )}
                    </Button>
                  </div>
                )}
              </div>
              <ScrollArea className="max-h-60">
                {urlInfo.items.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded transition-colors ${
                      urlInfo.type === 'playlist'
                        ? `cursor-pointer ${selectedUrlIds.has(item.id) ? 'bg-primary/10' : 'hover:bg-muted/50'}`
                        : 'hover:bg-muted/50'
                    }`}
                    onClick={() => urlInfo.type === 'playlist' && toggleUrlSelect(item.id)}
                  >
                    {urlInfo.type === 'playlist' && (
                      <input
                        type="checkbox"
                        checked={selectedUrlIds.has(item.id)}
                        onChange={() => toggleUrlSelect(item.id)}
                        className="shrink-0 accent-primary"
                      />
                    )}
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt="" className="h-8 w-12 rounded object-cover shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{item.title}</p>
                      <p className="text-[10px] text-muted-foreground">{item.artist} - {formatTime(item.duration)}</p>
                    </div>
                    {urlInfo.type === 'video' && (
                      <Button variant="default" size="sm" className="h-7 text-xs shrink-0"
                        onClick={(e) => { e.stopPropagation(); handleYtDownload(item.url || `https://youtube.com/watch?v=${item.id}`); }}
                        disabled={ytDownload.isPending}
                      >
                        <Download className="h-3 w-3 mr-1" /> Download
                      </Button>
                    )}
                  </div>
                ))}
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      {/* YouTube Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleYtSearch()}
            placeholder={`Search ${provider === 'soundcloud' ? 'SoundCloud' : 'YouTube'}…`}
            className="pl-9"
          />
        </div>
        <Select value={provider} onValueChange={(v) => setProvider(v as 'youtube' | 'soundcloud')}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="youtube">YouTube</SelectItem>
            <SelectItem value="soundcloud">SoundCloud</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={handleYtSearch} disabled={ytSearch.isPending || !searchQuery.trim()}>
          {ytSearch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
          Search
        </Button>
      </div>

      {/* YouTube Results */}
      {showYt && ytResults.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs">{provider === 'soundcloud' ? 'SoundCloud' : 'YouTube'} results ({ytResults.length})</CardTitle>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowYt(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-60 overflow-y-auto">
              {ytResults.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 transition-colors">
                  {r.thumbnail && (
                    <img src={r.thumbnail} alt="" className="h-10 w-14 rounded object-cover shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{r.title}</p>
                    <p className="text-[10px] text-muted-foreground">{r.artist} - {formatTime(r.duration)}</p>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => handleYtDownload(r.url)}
                    disabled={ytDownload.isPending}
                  >
                    <Download className="h-3 w-3 mr-1" /> Download
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Song List */}
      {isLoading ? <PageLoader /> : filtered.length === 0 ? (
        <EmptyState icon={Music} title="No songs yet" description="Upload audio files or download from YouTube / SoundCloud to build your library." />
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-2 px-3 py-2 bg-muted/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Title</span>
            <span className="w-20 text-right">Duration</span>
            <span className="w-16 text-center">Source</span>
            <span className="w-16 text-right">Size</span>
            <span className="w-16" />
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {filtered.map((song) => (
              <div key={song.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] gap-2 px-3 py-2 hover:bg-muted/30 transition-colors items-center border-t border-border/50">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{song.title}</p>
                  {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                </div>
                <span className="text-xs text-muted-foreground w-20 text-right">{formatTime(song.duration)}</span>
                <span className="w-16 flex justify-center">
                  <Badge variant="outline" className="text-[9px] gap-1">{sourceIcon(song.source)} {song.source}</Badge>
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">{song.fileSize ? formatBytes(song.fileSize) : '-'}</span>
                <div className="w-16 flex justify-end">
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(song.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Song?"
        description="This will permanently remove this song from the library."
        onConfirm={() => {
          if (deleteId && configId) deleteSong.mutate({ configId, songId: deleteId }, {
            onSuccess: () => { toast.success('Song deleted'); setDeleteId(null); },
          });
        }}
        destructive
      />
    </div>
  );
}

// ─── Playlists Tab ───────────────────────────────────────────────────────────

function PlaylistsTab() {
  const { selectedConfigId } = useServerStore();
  const { data, isLoading } = usePlaylists();
  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const addSong = useAddSongToPlaylist();
  const removeSong = useRemoveSongFromPlaylist();

  const { data: songs } = useSongs(selectedConfigId);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showAddSong, setShowAddSong] = useState(false);
  const [songFilter, setSongFilter] = useState('');

  const { data: detail } = usePlaylist(selectedId) as { data: PlaylistDetail | undefined };

  const playlists = (Array.isArray(data) ? data : []) as PlaylistSummary[];
  const songList = (Array.isArray(songs) ? songs : []) as SongInfo[];
  const playlistSongIds = new Set((detail?.songs || []).map((s: any) => s.id));
  const availableSongs = songList.filter((s) => !playlistSongIds.has(s.id) && (!songFilter || s.title.toLowerCase().includes(songFilter.toLowerCase())));

  const handleCreate = () => {
    createPlaylist.mutate({ name: newName }, {
      onSuccess: () => { toast.success('Playlist created'); setShowCreate(false); setNewName(''); },
      onError: () => toast.error('Failed to create playlist'),
    });
  };

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{playlists.length} playlist{playlists.length !== 1 ? 's' : ''}</p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Playlist
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* Playlist list */}
        <div className="space-y-1.5">
          {playlists.length === 0 ? (
            <EmptyState icon={ListMusic} title="No playlists" description="Create a playlist to organize your songs." />
          ) : playlists.map((pl) => (
            <div
              key={pl.id}
              className={`flex items-center gap-2 p-2.5 rounded-md cursor-pointer transition-colors ${
                selectedId === pl.id ? 'bg-primary/10 border border-primary/30' : 'hover:bg-muted/50 border border-transparent'
              }`}
              onClick={() => setSelectedId(pl.id)}
            >
              <ListMusic className={`h-4 w-4 shrink-0 ${selectedId === pl.id ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{pl.name}</p>
                <p className="text-[10px] text-muted-foreground">{pl.songCount} song{pl.songCount !== 1 ? 's' : ''}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                onClick={(e) => { e.stopPropagation(); setDeleteId(pl.id); }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>

        {/* Playlist detail */}
        {selectedId && detail ? (
          <Card>
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">{detail.name}</CardTitle>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowAddSong(true)}>
                  <Plus className="h-3 w-3 mr-1" /> Add Songs
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {detail.songs.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">No songs in this playlist</div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto">
                  {detail.songs.map((song: any, i: number) => (
                    <div key={song.id} className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors border-t border-border/50">
                      <span className="text-[10px] text-muted-foreground w-5 text-right">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{song.title}</p>
                        {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                      </div>
                      <span className="text-[10px] text-muted-foreground">{formatTime(song.duration)}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() => removeSong.mutate({ playlistId: selectedId, songId: song.id }, {
                          onSuccess: () => toast.success('Song removed'),
                        })}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center justify-center text-xs text-muted-foreground py-16">
            Select a playlist to view its songs
          </div>
        )}
      </div>

      {/* Create Playlist Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Playlist</DialogTitle></DialogHeader>
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Playlist"
              onKeyDown={(e) => e.key === 'Enter' && newName && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName || createPlaylist.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Song Dialog */}
      <Dialog open={showAddSong} onOpenChange={setShowAddSong}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add Songs to Playlist</DialogTitle></DialogHeader>
          <Input
            value={songFilter}
            onChange={(e) => setSongFilter(e.target.value)}
            placeholder="Filter songs..."
          />
          <ScrollArea className="max-h-72">
            {availableSongs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No songs available. Upload songs to the library first.</p>
            ) : availableSongs.map((song) => (
              <div key={song.id} className="flex items-center gap-2 py-1.5 hover:bg-muted/30 transition-colors rounded px-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs truncate">{song.title}</p>
                  {song.artist && <p className="text-[10px] text-muted-foreground truncate">{song.artist}</p>}
                </div>
                <Button variant="outline" size="sm" className="h-6 text-[10px] shrink-0"
                  onClick={() => {
                    if (selectedId) addSong.mutate({ playlistId: selectedId, songId: song.id }, {
                      onSuccess: () => toast.success('Song added'),
                    });
                  }}
                >
                  <Plus className="h-3 w-3 mr-0.5" /> Add
                </Button>
              </div>
            ))}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowAddSong(false); setSongFilter(''); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Playlist?"
        description="This will permanently delete this playlist."
        onConfirm={() => {
          if (deleteId) deletePlaylist.mutate(deleteId, {
            onSuccess: () => {
              toast.success('Playlist deleted');
              if (selectedId === deleteId) setSelectedId(null);
              setDeleteId(null);
            },
          });
        }}
        destructive
      />
    </div>
  );
}

// ─── Radio Tab ───────────────────────────────────────────────────────────────

function RadioTab() {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: stations, isLoading } = useRadioStations(configId);
  const { data: presets } = useRadioPresets(configId);
  const createStation = useCreateRadioStation();
  const deleteStation = useDeleteRadioStation();
  const playRadio = usePlayRadio();

  const { data: bots } = useMusicBots();
  const runningBots = (Array.isArray(bots) ? bots : []).filter(
    (b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error'
  );

  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', url: '', genre: '' });
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const serverList = Array.isArray(servers) ? servers : [];
  const stationList = (Array.isArray(stations) ? stations : []) as RadioStationInfo[];
  const presetList = (Array.isArray(presets) ? presets : []) as RadioPreset[];

  // Auto-select first running bot
  useEffect(() => {
    if (!selectedBotId && runningBots.length > 0) {
      setSelectedBotId(runningBots[0].id);
    }
  }, [runningBots, selectedBotId]);

  const handleAddStation = () => {
    if (!configId || !addForm.name || !addForm.url) return;
    createStation.mutate({
      configId,
      data: { name: addForm.name, url: addForm.url, genre: addForm.genre || undefined },
    }, {
      onSuccess: () => { toast.success('Station added'); setShowAdd(false); setAddForm({ name: '', url: '', genre: '' }); },
      onError: () => toast.error('Failed to add station'),
    });
  };

  const handleAddPreset = (preset: RadioPreset) => {
    if (!configId) return;
    createStation.mutate({
      configId,
      data: { name: preset.name, url: preset.url, genre: preset.genre },
    }, {
      onSuccess: () => toast.success(`Added: ${preset.name}`),
      onError: () => toast.error(`Failed to add: ${preset.name}`),
    });
  };

  const handlePlay = (stationId: number) => {
    if (!selectedBotId) {
      toast.error('Select a running bot first');
      return;
    }
    playRadio.mutate({ botId: selectedBotId, stationId }, {
      onSuccess: () => toast.success('Playing radio'),
      onError: () => toast.error('Failed to play radio'),
    });
  };

  if (!configId) {
    return <EmptyState icon={Radio} title="Select a server" description="Choose a server to manage radio stations." />;
  }

  return (
    <div className="space-y-4">
      {/* Server + Bot selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setServerId(parseInt(v))}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Server..." /></SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="h-6" />

        <Label className="text-xs text-muted-foreground">Play on:</Label>
        <Select
          value={selectedBotId ? String(selectedBotId) : ''}
          onValueChange={(v) => setSelectedBotId(parseInt(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder={runningBots.length === 0 ? 'No running bots' : 'Select bot...'} />
          </SelectTrigger>
          <SelectContent>
            {runningBots.map((b: MusicBotSummary) => (
              <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Button variant="outline" size="sm" onClick={() => setShowPresets(true)}>
          <Radio className="h-4 w-4 mr-1" /> Presets
        </Button>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Station
        </Button>
      </div>

      {runningBots.length === 0 && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
          <p className="text-xs text-amber-500">Start a music bot first to play radio stations.</p>
        </div>
      )}

      {/* Station List */}
      {isLoading ? <PageLoader /> : stationList.length === 0 ? (
        <EmptyState icon={Radio} title="No radio stations" description="Add stations manually or from presets to start streaming." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {stationList.map((station) => (
            <Card key={station.id} className="group hover:border-primary/30 transition-colors">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Radio className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{station.name}</p>
                  {station.genre && (
                    <Badge variant="outline" className="text-[9px] mt-0.5">{station.genre}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="default"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handlePlay(station.id)}
                    disabled={!selectedBotId || playRadio.isPending}
                  >
                    <Play className="h-4 w-4 ml-0.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => setDeleteId(station.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Station Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Radio Station</DialogTitle>
            <DialogDescription>Add a custom internet radio station by providing its stream URL.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Station name" />
            </div>
            <div>
              <Label className="text-xs">Stream URL</Label>
              <Input value={addForm.url} onChange={(e) => setAddForm({ ...addForm, url: e.target.value })} placeholder="https://stream.example.com/live" />
            </div>
            <div>
              <Label className="text-xs">Genre (optional)</Label>
              <Input value={addForm.genre} onChange={(e) => setAddForm({ ...addForm, genre: e.target.value })} placeholder="Pop, Rock, Electronic..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={handleAddStation} disabled={!addForm.name || !addForm.url || createStation.isPending}>
              Add Station
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Presets Dialog */}
      <Dialog open={showPresets} onOpenChange={setShowPresets}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col overflow-auto">
          <DialogHeader>
            <DialogTitle>Radio Presets</DialogTitle>
            <DialogDescription>Add popular radio stations with one click.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 max-h-[400px] overflow-y-auto">
            {presetList.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No presets available.</p>
            ) : presetList.map((preset, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2 hover:bg-muted/50 transition-colors rounded">
                <Radio className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{preset.name}</p>
                  <p className="text-[10px] text-muted-foreground">{preset.genre}</p>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                  onClick={() => handleAddPreset(preset)}
                  disabled={createStation.isPending}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPresets(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Radio Station?"
        description="This will remove this station from your list."
        onConfirm={() => {
          if (deleteId && configId) deleteStation.mutate({ configId, id: deleteId }, {
            onSuccess: () => { toast.success('Station removed'); setDeleteId(null); },
          });
        }}
        destructive
      />
    </div>
  );
}

// ─── Video Streaming Tab ─────────────────────────────────────────────────────

function VideoTab() {
  const { data } = useMusicBots();
  const bots = Array.isArray(data) ? data : [];
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);

  // Auto-select first running bot
  const runningBots = bots.filter((b: MusicBotSummary) => b.status !== 'stopped' && b.status !== 'error');
  useEffect(() => {
    if (!selectedBotId && runningBots.length > 0) {
      setSelectedBotId(runningBots[0].id);
    }
  }, [runningBots, selectedBotId]);

  const selectedBot = bots.find((b: MusicBotSummary) => b.id === selectedBotId);

  return (
    <div className="space-y-4">
      {bots.length === 0 ? (
        <EmptyState icon={Video} title="No bots available" description="Create a music bot first, then use it for video streaming." />
      ) : (
        <>
          {/* Bot selector */}
          <div className="flex items-center gap-3">
            <Label className="shrink-0">Select Bot:</Label>
            <Select
              value={selectedBotId ? String(selectedBotId) : ''}
              onValueChange={(v) => setSelectedBotId(parseInt(v))}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose a bot..." />
              </SelectTrigger>
              <SelectContent>
                {bots.map((b: MusicBotSummary) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name} — {b.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedBot ? (
            <VideoStreamTab botId={selectedBot.id} botStatus={selectedBot.status} />
          ) : (
            <p className="text-sm text-muted-foreground">Select a bot to manage video streaming.</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MusicBots() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Music</p>
          <h1 className="text-2xl font-bold">Studio</h1>
          <p className="text-sm text-muted-foreground">YouTube, SoundCloud, radio and your own library — streamed straight into TeamSpeak.</p>
        </div>
      </div>

      <Tabs defaultValue="player" className="space-y-4">
        <TabsList>
          <TabsTrigger value="player"><Disc3 className="mr-1.5 h-3.5 w-3.5" /> Player</TabsTrigger>
          <TabsTrigger value="library"><FileAudio className="mr-1.5 h-3.5 w-3.5" /> Library</TabsTrigger>
          <TabsTrigger value="playlists"><ListMusic className="mr-1.5 h-3.5 w-3.5" /> Playlists</TabsTrigger>
          <TabsTrigger value="radio"><Radio className="mr-1.5 h-3.5 w-3.5" /> Radio</TabsTrigger>
          <TabsTrigger value="video"><Video className="mr-1.5 h-3.5 w-3.5" /> Video</TabsTrigger>
        </TabsList>

        <TabsContent value="player"><PlayerView /></TabsContent>
        <TabsContent value="library"><LibraryTab /></TabsContent>
        <TabsContent value="playlists"><PlaylistsTab /></TabsContent>
        <TabsContent value="radio"><RadioTab /></TabsContent>
        <TabsContent value="video"><VideoTab /></TabsContent>
      </Tabs>
    </div>
  );
}
