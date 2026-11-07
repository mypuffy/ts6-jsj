import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import OpusScript from "opusscript";
import { validateUrl } from "../../utils/url-validator.js";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960; // 20ms at 48kHz
export const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 16-bit = 2 bytes per sample
export const FRAME_MS = 20;
const BITRATE = 96000;

export interface PcmStreamOptions {
  /** Start position in seconds (ignored for live streams) */
  seek?: number;
  /** Extra HTTP headers (from yt-dlp) */
  headers?: Record<string, string>;
  /** Live stream (radio) – no seeking, infinite duration */
  isLive?: boolean;
  /** Apply loudness normalization */
  normalize?: boolean;
}

export class AudioPipeline {
  private encoder: OpusScript;
  private opusPeak = 0;
  private lastOpusPeakLog = 0;

  constructor() {
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(BITRATE);
    // After this.encoder.setBitrate(BITRATE);

    const OPUS_SET_VBR = 4006;
    const OPUS_SET_VBR_CONSTRAINT = 4020;
    const OPUS_SET_SIGNAL = 4024;

    const OPUS_SIGNAL_MUSIC = 3002;

    // Hard CBR (reduces spikes)
    this.encoder.encoderCTL(OPUS_SET_VBR, 0);

    // (Optional; CBR ignores it, but harmless)
    this.encoder.encoderCTL(OPUS_SET_VBR_CONSTRAINT, 1);

    // Tell encoder it’s music (helps tuning)
    this.encoder.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
  }

  /**
   * Convert audio file to raw PCM (48kHz, mono, s16le) at full volume.
   */
  toPcm(filePath: string): Promise<Buffer> {
    return this.ffmpegToPcm(filePath);
  }

  /**
   * Split raw PCM buffer into 960-sample frames.
   */
  splitFrames(pcmData: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pcmData.length; offset += BYTES_PER_FRAME) {
      let frame = pcmData.subarray(offset, offset + BYTES_PER_FRAME);
      if (frame.length < BYTES_PER_FRAME) {
        const padded = Buffer.alloc(BYTES_PER_FRAME, 0);
        frame.copy(padded);
        frame = padded;
      }
      frames.push(frame);
    }
    return frames;
  }

  /**
   * Encode a single PCM frame to Opus, applying volume scaling in real-time.
   */
  encodeFrame(pcmFrame: Buffer, volume: number): Buffer {
    let input = pcmFrame;
    if (volume !== 100) {
      const scaled = Buffer.alloc(pcmFrame.length);
      const factor = volume / 100;
      for (let i = 0; i < pcmFrame.length; i += 2) {
        const sample = pcmFrame.readInt16LE(i);
        const v = Math.round(sample * factor);
        scaled.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
      }
      input = scaled;
    }
    const encoded = this.encoder.encode(input, FRAME_SIZE);
    const opusFrame = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);

    this.opusPeak = Math.max(this.opusPeak, opusFrame.length);

    //const now = Date.now();
    //if (now - this.lastOpusPeakLog > 1000) {
    //  console.log(`[voice] opus peak (1s): ${this.opusPeak} bytes`);
    //  this.opusPeak = 0;
    //  this.lastOpusPeakLog = now;
    //}

    return opusFrame;
  }

  /**
   * Stream audio from a URL to raw PCM (for live radio streams).
   * Returns a readable stdout stream + kill function. Does NOT buffer the entire stream.
   */
  async toPcmStream(url: string): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void; getError: () => string }> {
    return this.openPcmStream(url, { isLive: true });
  }

  /**
   * Universal streaming decoder: local file, direct HTTP(S) URL, HLS (SoundCloud) or radio.
   * Output is 48 kHz stereo s16le on stdout. Nothing is buffered in memory here –
   * the caller applies backpressure by pausing stdout.
   */
  async openPcmStream(input: string, opts: PcmStreamOptions = {}): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void; getError: () => string }> {
    const isHttp = /^https?:\/\//i.test(input);
    if (isHttp) {
      // C4: Validate URL before passing to ffmpeg
      const urlCheck = await validateUrl(input, { allowedProtocols: ['http:', 'https:'] });
      if (!urlCheck.valid) {
        throw new Error(`Stream URL blocked: ${urlCheck.error}`);
      }
    }

    const args: string[] = ['-hide_banner', '-nostdin'];

    if (isHttp) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      if (!opts.isLive) args.push('-reconnect_on_network_error', '1');
      const headers = { ...(opts.headers || {}) };
      const ua = headers['User-Agent'] || headers['user-agent'];
      delete headers['User-Agent'];
      delete headers['user-agent'];
      if (ua) args.push('-user_agent', ua);
      const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (headerStr) args.push('-headers', headerStr);
    }

    // Fast input seeking (before -i)
    if (opts.seek && opts.seek > 0 && !opts.isLive) {
      args.push('-ss', opts.seek.toFixed(2));
    }

    args.push('-i', input, '-vn');

    if (opts.normalize) {
      // Dynamic normalizer: evens out loudness between quiet YouTube uploads and loud SoundCloud masters
      args.push('-af', 'dynaudnorm=f=250:g=15:p=0.9:m=8');
    }

    args.push(
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-loglevel', 'error',
      'pipe:1',
    );

    const ffmpeg = spawn('ffmpeg', args, { shell: false });
    let errTail = '';
    ffmpeg.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (!msg) return;
      errTail = (errTail + '\n' + msg).slice(-600);
      if (process.env.VOICE_DEBUG === '1') console.log(`[ffmpeg] ${msg.slice(0, 300)}`);
    });
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill('SIGKILL'); } catch { }
      },
      getError: () => errTail.trim(),
    };
  }

  /**
   * Fallback: let yt-dlp download the stream itself (handles YouTube PO tokens,
   * cookies, DASH/HLS fragments) and pipe it into FFmpeg.
   */
  openYtDlpPcmStream(url: string, opts: { seek?: number; normalize?: boolean; ytdlpArgs?: string[] } = {}): { stdout: Readable; process: ChildProcess; kill: () => void; getError: () => string } {
    const ytdlp = spawn('yt-dlp', [
      ...(opts.ytdlpArgs ?? []),
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--no-part',
      '--quiet', '--no-warnings',
      '-o', '-',
      url,
    ], { shell: false });

    const args: string[] = ['-hide_banner', '-nostdin'];
    if (opts.seek && opts.seek > 0) args.push('-ss', opts.seek.toFixed(2));
    args.push('-i', 'pipe:0', '-vn');
    if (opts.normalize) args.push('-af', 'dynaudnorm=f=250:g=15:p=0.9:m=8');
    args.push('-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-loglevel', 'error', 'pipe:1');
    const ffmpeg = spawn('ffmpeg', args, { shell: false });

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => { /* EPIPE when ffmpeg is killed */ });
    ytdlp.stdout.on('error', () => { });

    let errTail = '';
    const collect = (tag: string) => (c: Buffer) => {
      const msg = c.toString().trim();
      if (!msg) return;
      errTail = (errTail + `\n[${tag}] ` + msg).slice(-600);
      if (process.env.VOICE_DEBUG === '1') console.log(`[${tag}] ${msg.slice(0, 300)}`);
    };
    ytdlp.stderr.on('data', collect('yt-dlp'));
    ffmpeg.stderr?.on('data', collect('ffmpeg'));
    ytdlp.on('error', (e) => { errTail += `\n[yt-dlp] ${e.message}`; try { ffmpeg.stdin.end(); } catch { } });

    const kill = () => {
      try { ytdlp.kill('SIGKILL'); } catch { }
      try { ffmpeg.kill('SIGKILL'); } catch { }
    };
    ffmpeg.on('close', () => { try { ytdlp.kill('SIGKILL'); } catch { } });
    return { stdout: ffmpeg.stdout, process: ffmpeg, kill, getError: () => errTail.trim() };
  }

  private ffmpegToPcm(input: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = [
        "-i", input,
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-loglevel", "error",
        "pipe:1",
      ];

      const ffmpeg = spawn("ffmpeg", args, { shell: false });
      const chunks: Buffer[] = [];

      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on("data", () => { });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on("error", (err) => {
        reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
      });
    });
  }
}
