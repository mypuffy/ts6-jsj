import net from 'net';
import type { WebQueryClient } from '../ts-client/webquery-client.js';

/**
 * Upload a file to a virtual server via the TeamSpeak file-transfer protocol:
 *  1. `ftinitupload` (WebQuery) → ftkey + port
 *  2. TCP connect to <host>:<port>, send the 32-char ftkey, then the raw bytes.
 * Used for group/channel icons ("/icon_<crc32>" in channel 0).
 */
export async function uploadFile(
  client: WebQueryClient,
  sid: number,
  host: string,
  path: string,
  data: Buffer,
  opts: { cid?: number; cpw?: string; timeoutMs?: number } = {},
): Promise<void> {
  const clientftfid = Math.floor(Math.random() * 60000) + 1;
  const res = await client.executePost(sid, 'ftinitupload', {
    clientftfid,
    name: path,
    cid: opts.cid ?? 0,
    cpw: opts.cpw ?? '',
    size: data.length,
    overwrite: 1,
    resume: 0,
  });
  const info = Array.isArray(res) ? res[0] : res;
  if (!info?.ftkey) {
    const msg = info?.msg || info?.status || 'no ftkey returned';
    throw new Error(`ftinitupload failed: ${msg}`);
  }
  const port = parseInt(info.port, 10) || 30033;
  // Some servers return an explicit ip list ("0.0.0.0,::"); fall back to the configured host
  const ip = typeof info.ip === 'string' && info.ip && !/^0\.0\.0\.0|^::/.test(info.ip.split(',')[0])
    ? info.ip.split(',')[0]
    : host;

  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`file transfer to ${ip}:${port} timed out`)); }, opts.timeoutMs ?? 15000);
    sock.on('connect', () => {
      sock.write(Buffer.from(String(info.ftkey), 'ascii'));
      sock.end(data);
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(new Error(`file transfer to ${ip}:${port} failed: ${err.message}`)); });
    sock.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

/** List icon files already on the server ("icon_123…") */
export async function listIcons(client: WebQueryClient, sid: number): Promise<Set<number>> {
  try {
    const res = await client.execute(sid, 'ftgetfilelist', { cid: 0, cpw: '', path: '/icons/' });
    const list = Array.isArray(res) ? res : [];
    const ids = new Set<number>();
    for (const f of list) {
      const m = String(f.name ?? '').match(/^icon_(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
    return ids;
  } catch {
    return new Set();
  }
}
