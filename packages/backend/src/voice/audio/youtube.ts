import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export interface YouTubeInfo {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds
  thumbnail: string;
  url: string;
}

export interface YouTubeSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

// Shared cookie file path (set from settings)
let ytCookieFile: string | null = null;

export function setYtCookieFile(filePath: string | null): void {
  ytCookieFile = filePath;
}

export function getYtCookieFile(): string | null {
  return ytCookieFile;
}

export function getCookieArgs(): string[] {
  const args: string[] = ["--remote-components", "ejs:github"];
  if (ytCookieFile) {
    args.push("--cookies", ytCookieFile);
  }
  return args;
}

/**
 * Download audio from any yt-dlp supported URL (YouTube, SoundCloud, Bandcamp, ...).
 * Files are stored as "<extractor>_<id>.<ext>" so IDs from different sites never collide.
 */
export function downloadYouTube(url: string, outputDir: string): Promise<{ filePath: string; info: YouTubeInfo & { source: string } }> {
  return new Promise((resolve, reject) => {
    const infoProc = spawn("yt-dlp", [
      ...getCookieArgs(),
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      url,
    ], { shell: false });

    let infoJson = "";
    let infoErr = "";
    infoProc.stdout.on("data", (chunk: Buffer) => { infoJson += chunk.toString(); });
    infoProc.stderr.on("data", (chunk: Buffer) => { infoErr += chunk.toString(); });

    infoProc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info failed (code ${code}): ${infoErr.slice(0, 200)}`));
      }

      let parsed: any;
      try {
        parsed = JSON.parse(infoJson);
      } catch {
        return reject(new Error("Failed to parse yt-dlp output"));
      }

      const extractor = String(parsed.extractor_key || parsed.extractor || "web").toLowerCase().replace(/[^a-z0-9]/g, "");
      const safeId = String(parsed.id).replace(/[^\w.-]/g, "_");
      const baseName = `${extractor}_${safeId}`;
      const source = extractor.includes("soundcloud") ? "soundcloud" : extractor.includes("youtube") ? "youtube" : "url";

      const info = {
        id: String(parsed.id),
        title: parsed.track || parsed.title || "Unknown",
        artist: parsed.artist || parsed.uploader || parsed.channel || "Unknown",
        duration: parsed.duration || 0,
        thumbnail: parsed.thumbnail || "",
        url: parsed.webpage_url || url,
        source,
      };

      // Already downloaded? (new naming scheme or legacy "<id>.*" YouTube files)
      const existing = fs.readdirSync(outputDir).find((f) => f.startsWith(baseName + ".") || (source === "youtube" && f.startsWith(safeId + ".")));
      if (existing) {
        return resolve({ filePath: path.join(outputDir, existing), info });
      }

      const dlProc = spawn("yt-dlp", [
        ...getCookieArgs(),
        "-f", "bestaudio/best",
        "-x",
        "--audio-format", "opus",
        "--audio-quality", "0",
        "--no-playlist",
        "--no-warnings",
        "-o", path.join(outputDir, `${baseName}.%(ext)s`),
        url,
      ], { shell: false });

      let dlErr = "";
      dlProc.stderr.on("data", (chunk: Buffer) => { dlErr += chunk.toString(); });

      dlProc.on("close", (dlCode) => {
        if (dlCode !== 0) {
          return reject(new Error(`yt-dlp download failed (code ${dlCode}): ${dlErr.slice(0, 200)}`));
        }
        const files = fs.readdirSync(outputDir).filter((f) => f.startsWith(baseName + ".") && !f.endsWith(".part"));
        if (files.length === 0) {
          return reject(new Error("Downloaded file not found"));
        }
        resolve({ filePath: path.join(outputDir, files[files.length - 1]), info });
      });

      dlProc.on("error", (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));
    });

    infoProc.on("error", (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));
  });
}

/** Alias with a clearer name – works for every yt-dlp source, not only YouTube. */
export const downloadTrack = downloadYouTube;

/**
 * Get info about a YouTube URL (single video or playlist).
 * Returns type ('video' or 'playlist') and array of items.
 */
export function getYouTubeUrlInfo(url: string): Promise<{ type: 'video' | 'playlist'; items: YouTubeSearchResult[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
        ...getCookieArgs(),
        "--dump-json",
      "--flat-playlist",
      "--no-download",
      url,
    ], { shell: false });

    let output = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      try {
        const lines = output.trim().split("\n").filter(Boolean);
        const items: YouTubeSearchResult[] = lines.map((line) => {
          const parsed = JSON.parse(line);
          return {
            id: parsed.id,
            title: parsed.title || "Unknown",
            artist: parsed.uploader || parsed.channel || "Unknown",
            duration: parsed.duration || 0,
            thumbnail: parsed.thumbnails?.[0]?.url || parsed.thumbnail || "",
          };
        });

        const type = items.length > 1 ? 'playlist' : 'video';
        resolve({ type, items });
      } catch {
        reject(new Error("Failed to parse yt-dlp output"));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/**
 * Search YouTube using yt-dlp
 */
export function searchYouTube(query: string, maxResults: number = 10): Promise<YouTubeSearchResult[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
        ...getCookieArgs(),
        `ytsearch${maxResults}:${query}`,
      "--dump-json",
      "--flat-playlist",
      "--no-download",
    ], { shell: false });

    let output = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp search failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      try {
        // yt-dlp outputs one JSON object per line
        const results = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parsed = JSON.parse(line);
            return {
              id: parsed.id,
              title: parsed.title || "Unknown",
              artist: parsed.uploader || parsed.channel || "Unknown",
              duration: parsed.duration || 0,
              thumbnail: parsed.thumbnails?.[0]?.url || "",
            };
          });

        resolve(results);
      } catch {
        resolve([]);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}
