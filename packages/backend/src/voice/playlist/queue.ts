export type RepeatMode = "off" | "track" | "queue";

export type QueueSource = "local" | "youtube" | "soundcloud" | "url" | "radio";

export interface QueueItem {
  /** Logical id (song id, "yt_xxx", "sc_123", "radio_1"...). May repeat in the queue. */
  id: string;
  /** Unique per queue entry – assigned automatically on add */
  uid?: string;
  title: string;
  artist?: string;
  duration?: number; // seconds
  /** Local file (library song or cache). Empty for remote/streamed items. */
  filePath: string;
  source: QueueSource;
  /** Page URL that can be resolved again (YouTube/SoundCloud/...) */
  sourceUrl?: string;
  /** If set, play as live stream (radio) */
  streamUrl?: string;
  thumbnail?: string;
  requestedBy?: string;
  addedAt?: number;
  /** Cached direct stream (never sent to the frontend) */
  resolved?: { url: string; headers: Record<string, string>; isLive: boolean; at: number };
}

/** Public, serialisable view of a queue item (no signed URLs / headers). */
export function publicItem(item: QueueItem | null | undefined) {
  if (!item) return null;
  const { resolved: _r, filePath: _f, ...rest } = item;
  return rest;
}

let uidCounter = 0;
const nextUid = () => `q${Date.now().toString(36)}${(++uidCounter).toString(36)}`;

/**
 * Play queue stored in *display order*.
 * Shuffle physically reorders the upcoming part of the queue (like Spotify),
 * and can be undone because every item remembers its insertion sequence.
 */
export class PlayQueue {
  private items: Array<QueueItem & { _seq: number }> = [];
  private currentIndex = -1;
  private _shuffle = false;
  private _repeat: RepeatMode = "off";
  private seq = 0;
  /** True when playback ran past the last item (queue finished) */
  private ended = false;

  get current(): QueueItem | null {
    if (this.ended) return null;
    return this.items[this.currentIndex] ?? null;
  }

  get length(): number {
    return this.items.length;
  }

  get index(): number {
    return this.ended ? -1 : this.currentIndex;
  }

  get repeat(): RepeatMode {
    return this._repeat;
  }

  get shuffle(): boolean {
    return this._shuffle;
  }

  /** Number of tracks after the current one */
  get upcomingCount(): number {
    return Math.max(0, this.items.length - (this.currentIndex + 1));
  }

  getAll(): QueueItem[] {
    return this.items.map(({ _seq, ...item }) => item);
  }

  getUpcoming(limit = 50): QueueItem[] {
    return this.getAll().slice(this.currentIndex + 1, this.currentIndex + 1 + limit);
  }

  private wrap(item: QueueItem) {
    return { ...item, uid: item.uid || nextUid(), addedAt: item.addedAt ?? Date.now(), _seq: ++this.seq };
  }

  /** Append to the end (random upcoming position while shuffle is on). Returns display position. */
  add(item: QueueItem): number {
    const w = this.wrap(item);
    if (this._shuffle && this.upcomingCount > 0) {
      const start = this.currentIndex + 1;
      const pos = start + Math.floor(Math.random() * (this.items.length - start + 1));
      this.items.splice(pos, 0, w);
      return pos;
    }
    this.items.push(w);
    return this.items.length - 1;
  }

  addMany(items: QueueItem[]): void {
    for (const item of items) this.add(item);
  }

  /** Insert directly after the current track ("play next"). Returns display position. */
  insertNext(item: QueueItem): number {
    const pos = this.currentIndex + 1;
    this.items.splice(pos, 0, this.wrap(item));
    return pos;
  }

  insertManyNext(items: QueueItem[]): number {
    const start = this.currentIndex + 1;
    let pos = start;
    for (const item of items) this.items.splice(pos++, 0, this.wrap(item));
    return start;
  }

  /** Remove by logical id or uid (first match). */
  remove(id: string): boolean {
    const idx = this.items.findIndex((item) => item.uid === id || item.id === id);
    if (idx < 0) return false;
    return this.removeAt(idx) !== null;
  }

  /** Remove by display index. Returns the removed item. */
  removeAt(idx: number): QueueItem | null {
    if (idx < 0 || idx >= this.items.length) return null;
    const [removed] = this.items.splice(idx, 1);
    if (idx < this.currentIndex) {
      this.currentIndex--;
    } else if (idx === this.currentIndex) {
      // Current entry removed: step back so next() continues with the following item
      this.currentIndex--;
    }
    const { _seq, ...item } = removed;
    return item;
  }

  clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.ended = false;
  }

  /** Remove everything after the current track, keep history + current. */
  clearUpcoming(): number {
    const n = this.upcomingCount;
    this.items.splice(this.currentIndex + 1);
    return n;
  }

  /** Drop already-played entries before the current one. */
  trimHistory(keep = 0): void {
    const drop = Math.max(0, this.currentIndex - keep);
    if (drop > 0) {
      this.items.splice(0, drop);
      this.currentIndex -= drop;
    }
  }

  /** Look at the next item without advancing. */
  peekNext(): QueueItem | null {
    if (this.items.length === 0) return null;
    const i = this.currentIndex + 1;
    if (i < this.items.length) return this.items[i];
    if (this._repeat === "queue") return this.items[0];
    return null;
  }

  next(): QueueItem | null {
    if (this.items.length === 0) return null;

    // Track repeat is handled by VoiceBot directly — here we just advance
    if (this.currentIndex + 1 < this.items.length) {
      this.currentIndex++;
      this.ended = false;
      return this.current;
    }
    if (this._repeat === "queue") {
      this.currentIndex = 0;
      this.ended = false;
      if (this._shuffle) this.shuffleRange(0);
      return this.current;
    }
    // Finished – stay on the last item so newly added tracks continue from here
    this.currentIndex = this.items.length - 1;
    this.ended = true;
    return null;
  }

  playAt(index: number): QueueItem | null {
    if (index < 0 || index >= this.items.length) return null;
    this.currentIndex = index;
    this.ended = false;
    return this.current;
  }

  previous(): QueueItem | null {
    if (this.items.length === 0) return null;

    if (this.ended) {
      // Queue had finished: "previous" replays the last track
      this.ended = false;
      return this.current;
    }
    this.currentIndex--;
    if (this.currentIndex < 0) {
      this.currentIndex = this._repeat === "queue" ? this.items.length - 1 : 0;
    }

    return this.current;
  }

  move(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.items.length) return false;
    if (toIndex < 0 || toIndex >= this.items.length) return false;
    if (fromIndex === toIndex) return true;

    const [item] = this.items.splice(fromIndex, 1);
    this.items.splice(toIndex, 0, item);

    // Keep currentIndex pointing at the currently playing track
    if (this.currentIndex === fromIndex) {
      this.currentIndex = toIndex;
    } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
      this.currentIndex--;
    } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
      this.currentIndex++;
    }
    return true;
  }

  setRepeat(mode: RepeatMode): void {
    this._repeat = mode;
  }

  setShuffle(enabled: boolean): void {
    if (enabled === this._shuffle) {
      if (enabled) this.shuffleRange(this.currentIndex + 1); // re-shuffle on repeated request
      return;
    }
    this._shuffle = enabled;
    const start = this.currentIndex + 1;
    if (enabled) {
      // Remember the current order so turning shuffle off restores it
      for (let i = start; i < this.items.length; i++) this.items[i]._seq = ++this.seq;
      this.shuffleRange(start);
    } else {
      // Restore insertion order of the upcoming part
      const upcoming = this.items.splice(start).sort((a, b) => a._seq - b._seq);
      this.items.push(...upcoming);
    }
  }

  private shuffleRange(start: number): void {
    const s = Math.max(0, start);
    for (let i = this.items.length - 1; i > s; i--) {
      const j = s + Math.floor(Math.random() * (i - s + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
  }
}
