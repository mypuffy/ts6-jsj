/**
 * Settings routes — app-wide configuration (admin only).
 * Currently handles yt-dlp cookie file management.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { AppError } from '../middleware/error-handler.js';
import { setYtCookieFile, getYtCookieFile } from '../voice/audio/youtube.js';
import { runYtDlp } from '../voice/audio/sources.js';
import { spawn } from 'child_process';

const settingsRoutes: Router = Router();

// Cookie file stored in the backend data directory (persisted in Docker volume)
const COOKIE_DIR = path.resolve('data');
const COOKIE_PATH = path.join(COOKIE_DIR, 'yt-cookies.txt');

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  storage: multer.memoryStorage(),
});

// Admin-only guard
function requireAdmin(req: Request, _res: Response, next: Function) {
  if ((req as any).user?.role !== 'admin') {
    return next(new AppError(403, 'Admin access required'));
  }
  next();
}

// GET /api/settings/yt-cookies — Check cookie file status
settingsRoutes.get('/yt-cookies', requireAdmin, (_req: Request, res: Response) => {
  const exists = fs.existsSync(COOKIE_PATH);
  const activePath = getYtCookieFile();
  res.json({
    active: !!activePath,
    exists,
    size: exists ? fs.statSync(COOKIE_PATH).size : 0,
    path: activePath,
  });
});

// POST /api/settings/yt-cookies — Upload cookie file
settingsRoutes.post('/yt-cookies', requireAdmin, upload.single('cookies'), (req: Request, res: Response, next) => {
  try {
    if (!req.file) {
      // Check if raw text was sent in body
      const text = req.body?.text;
      if (!text || typeof text !== 'string') {
        throw new AppError(400, 'No cookie file or text provided');
      }
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
      fs.writeFileSync(COOKIE_PATH, text, 'utf-8');
    } else {
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
      fs.writeFileSync(COOKIE_PATH, req.file.buffer);
    }

    setYtCookieFile(COOKIE_PATH);
    const size = fs.statSync(COOKIE_PATH).size;
    console.log(`[yt-dlp] Cookie file uploaded (${size} bytes)`);
    res.json({ success: true, size });
  } catch (err) { next(err); }
});

// DELETE /api/settings/yt-cookies — Remove cookie file
settingsRoutes.delete('/yt-cookies', requireAdmin, (_req: Request, res: Response, next) => {
  try {
    if (fs.existsSync(COOKIE_PATH)) {
      fs.unlinkSync(COOKIE_PATH);
    }
    setYtCookieFile(null);
    console.log('[yt-dlp] Cookie file removed');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/settings/yt-dlp — Installed yt-dlp version (YouTube/SoundCloud break when it gets old)
settingsRoutes.get('/yt-dlp', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const version = (await runYtDlp(['--version'], 10_000)).trim();
    res.json({ installed: true, version });
  } catch (err: any) {
    res.json({ installed: false, version: null, error: err.message });
  }
});

// POST /api/settings/yt-dlp/update — Update yt-dlp in place via pip (Docker image ships pip)
settingsRoutes.post('/yt-dlp/update', requireAdmin, (_req: Request, res: Response, next) => {
  const proc = spawn('python3', ['-m', 'pip', 'install', '-U', '--no-cache-dir', '--break-system-packages', 'yt-dlp[default]', 'bgutil-ytdlp-pot-provider', 'deno'], { shell: false });
  let out = '';
  proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  proc.stderr.on('data', (c: Buffer) => { out += c.toString(); });
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 180_000);
  proc.on('error', (err) => { clearTimeout(timer); next(new AppError(500, `pip not available: ${err.message}`)); });
  proc.on('close', async (code) => {
    clearTimeout(timer);
    if (code !== 0) return next(new AppError(500, `Update failed: ${out.slice(-400)}`));
    let version: string | null = null;
    try { version = (await runYtDlp(['--version'], 10_000)).trim(); } catch { }
    console.log(`[yt-dlp] Updated to ${version}`);
    res.json({ success: true, version });
  });
});

export { settingsRoutes };
