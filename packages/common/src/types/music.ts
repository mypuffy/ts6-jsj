// === Music / Voice Bot Types ===

export type VoiceBotStatus = 'stopped' | 'starting' | 'connected' | 'playing' | 'paused' | 'error';

export interface MusicBotSummary {
  id: number;
  name: string;
  serverConfigId: number;
  serverConfig?: { id: number; name: string; host: string };
  nickname: string;
  serverPassword: string | null;
  defaultChannel: string | null;
  channelPassword: string | null;
  voicePort: number;
  volume: number;
  autoStart: boolean;
  status: VoiceBotStatus;
  nowPlaying: QueueItemInfo | null;
  createdAt: string;
  // Music behaviour
  normalize?: boolean;
  autoplay?: boolean;
  announce?: boolean;
  autoPauseEmpty?: boolean;
  nowPlayingNick?: boolean;
  commandPrefix?: string;
  defaultSearch?: SearchProvider;
  djGroupIds?: string;
  djOnly?: boolean;
  maxQueuePerUser?: number;
  voteSkipPercent?: number;
  eqPreset?: string;
  resumeQueue?: boolean;
  // Runtime
  listeners?: number;
  channelName?: string;
  queueLength?: number;
}

export type SearchProvider = 'youtube' | 'soundcloud';
export type TrackSource = 'local' | 'youtube' | 'soundcloud' | 'url' | 'radio';
export type EnqueueMode = 'now' | 'next' | 'queue';

/** Result of a YouTube/SoundCloud search or URL resolve */
export interface TrackSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  url: string;
  source: TrackSource;
}

export interface MusicBotSettings {
  normalize: boolean;
  autoplay: boolean;
  announce: boolean;
  autoPauseEmpty: boolean;
  nowPlayingNick: boolean;
  commandPrefix: string;
  defaultSearch: SearchProvider;
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

export interface MusicBotDetail extends MusicBotSummary {
  updatedAt: string;
  playbackProgress: { position: number; duration: number } | null;
}

export interface CreateMusicBotRequest {
  name: string;
  serverConfigId: number;
  nickname?: string;
  serverPassword?: string;
  defaultChannel?: string;
  channelPassword?: string;
  voicePort?: number;
  volume?: number;
  autoStart?: boolean;
}

export interface UpdateMusicBotRequest {
  name?: string;
  nickname?: string;
  serverPassword?: string;
  defaultChannel?: string;
  channelPassword?: string;
  voicePort?: number;
  volume?: number;
  autoStart?: boolean;
}

// === Song Types ===

export interface SongInfo {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
  filePath: string;
  source: 'local' | 'youtube' | 'soundcloud' | 'url';
  sourceUrl: string | null;
  thumbnail?: string | null;
  fileSize: number | null;
  serverConfigId: number;
  createdAt: string;
}

export interface QueueItemInfo {
  id: string;
  uid?: string;
  title: string;
  artist?: string;
  duration?: number;
  source: string;
  sourceUrl?: string;
  streamUrl?: string;
  thumbnail?: string;
  requestedBy?: string;
  addedAt?: number;
}

export type RepeatMode = 'off' | 'track' | 'queue';

export interface PlaybackState {
  status: VoiceBotStatus;
  nowPlaying: QueueItemInfo | null;
  position: number;
  duration: number;
  volume: number;
  queue: QueueItemInfo[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
  isStreaming?: boolean;
  upcomingCount?: number;
  loading?: boolean;
  autoplay?: boolean;
  autoPaused?: boolean;
  channelId?: number;
  channelName?: string;
  listeners?: { clid: number; nickname: string }[];
  history?: HistoryEntry[];
  lastError?: string;
  eqPreset?: string;
  sleepUntil?: number;
}

// === Playlist Types ===

export interface PlaylistSummary {
  id: number;
  name: string;
  musicBotId: number | null;
  songCount: number;
  createdAt: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: (SongInfo & { position: number })[];
}

// === YouTube Types ===

export interface YouTubeSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

// === Radio Station Types ===

export interface RadioStationInfo {
  id: number;
  name: string;
  url: string;
  genre: string | null;
  imageUrl: string | null;
  serverConfigId: number;
}

export interface RadioPreset {
  name: string;
  url: string;
  genre: string;
}

export interface YouTubeUrlInfo {
  type: 'video' | 'playlist';
  items: YouTubeSearchResult[];
}

// === Video Streaming Types ===

export type VideoStreamPresetKey = '480p' | '720p' | '1080p';

export interface VideoStreamPreset {
  label: string;
  width: number;
  height: number;
  bitrate: string;
  framerate: number;
}

export interface VideoStreamStatus {
  streaming: boolean;
  streamId: string | null;
  source: string | null;
  preset: string;
  startedAt: number | null;
  viewerCount: number;
  viewers: VideoViewerInfo[];
  sidecar: { videoPort: number; audioPort: number } | null;
}

export interface VideoViewerInfo {
  clid: number;
  joinedAt: number;
  iceState: string;
}

export interface StartVideoStreamRequest {
  source: string;
  preset?: VideoStreamPresetKey;
}

export interface SetVideoSourceRequest {
  source: string;
}
