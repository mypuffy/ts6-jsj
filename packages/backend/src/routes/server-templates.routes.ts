import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import { BUILTIN_TEMPLATES } from '../server-templates/builtin.js';
import { TemplateApplier, exportServer } from '../server-templates/apply.js';
import { iconDataUrls, ICONS, prepareIcon, crc32, isPng } from '../server-templates/icons.js';
import { uploadFile } from '../server-templates/file-transfer.js';
import type { ServerTemplate, ApplyOptions } from '../server-templates/types.js';

/** Global template library: /api/server-templates */
export const serverTemplateLibraryRoutes: Router = Router();
serverTemplateLibraryRoutes.use(requireRole('admin'));

/** Per virtual server: /api/servers/:configId/vs/:sid/server-templates */
export const serverTemplateRoutes: Router = Router({ mergeParams: true });
serverTemplateRoutes.use(requireRole('admin'));

function validateTemplate(t: any): ServerTemplate {
  if (!t || typeof t !== 'object') throw new AppError(400, 'Template must be an object');
  if (!t.name || typeof t.name !== 'string') throw new AppError(400, 'Template needs a name');
  if (!Array.isArray(t.channels)) throw new AppError(400, 'Template needs a channels array');
  if (!Array.isArray(t.serverGroups)) t.serverGroups = [];
  const countChannels = (cs: any[]): number => cs.reduce((n, c) => n + 1 + (Array.isArray(c?.children) ? countChannels(c.children) : 0), 0);
  if (countChannels(t.channels) > 500) throw new AppError(400, 'Too many channels (max 500)');
  if (t.serverGroups.length > 100) throw new AppError(400, 'Too many groups (max 100)');
  for (const g of [...t.serverGroups, ...(t.channelGroups ?? [])]) {
    if (!g?.name || !g?.key) throw new AppError(400, 'Every group needs key and name');
    if (g.icon && !ICONS[g.icon]) throw new AppError(400, `Unknown icon "${g.icon}"`);
  }
  return t as ServerTemplate;
}

async function loadTemplate(req: Request, id: string): Promise<ServerTemplate> {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return structuredClone(builtin);
  const m = id.match(/^saved-(\d+)$/);
  if (m) {
    const row = await req.app.locals.prisma.serverLayoutTemplate.findUnique({ where: { id: parseInt(m[1]) } });
    if (row) return { ...JSON.parse(row.data), id };
  }
  throw new AppError(404, 'Template not found');
}

// GET /api/server-templates — built-in + saved templates and the icon set
serverTemplateLibraryRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const saved = await req.app.locals.prisma.serverLayoutTemplate.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json({
      icons: iconDataUrls(),
      templates: [
        ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })),
        ...saved.map((s: any) => {
          try {
            return { ...JSON.parse(s.data), id: `saved-${s.id}`, name: s.name, description: s.description, builtin: false };
          } catch {
            return null;
          }
        }).filter(Boolean),
      ],
    });
  } catch (err) { next(err); }
});

// POST /api/server-templates — save / import a template
serverTemplateLibraryRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const t = validateTemplate(req.body.template ?? req.body);
    const row = await req.app.locals.prisma.serverLayoutTemplate.create({
      data: { name: t.name.slice(0, 100), description: String(t.description ?? '').slice(0, 500), data: JSON.stringify({ ...t, category: t.category ?? 'custom' }) },
    });
    res.status(201).json({ id: `saved-${row.id}` });
  } catch (err) { next(err); }
});

// PUT /api/server-templates/:id — update a saved template
serverTemplateLibraryRoutes.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const m = String(req.params.id).match(/^saved-(\d+)$/);
    if (!m) throw new AppError(400, 'Built-in templates cannot be edited – save a copy instead');
    const t = validateTemplate(req.body.template ?? req.body);
    await req.app.locals.prisma.serverLayoutTemplate.update({
      where: { id: parseInt(m[1]) },
      data: { name: t.name.slice(0, 100), description: String(t.description ?? '').slice(0, 500), data: JSON.stringify(t) },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/server-templates/:id
serverTemplateLibraryRoutes.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const m = String(req.params.id).match(/^saved-(\d+)$/);
    if (!m) throw new AppError(400, 'Built-in templates cannot be deleted');
    await req.app.locals.prisma.serverLayoutTemplate.delete({ where: { id: parseInt(m[1]) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST …/server-templates/apply  { templateId? | template?, options }
serverTemplateRoutes.post('/apply', async (req: Request, res: Response, next) => {
  try {
    const configId = parseInt(String(req.params.configId));
    const sid = parseInt(String(req.params.sid));
    const pool: ConnectionPool = req.app.locals.connectionPool;
    const client = pool.getClient(configId);
    const server = await req.app.locals.prisma.tsServerConfig.findUnique({ where: { id: configId } });
    if (!server) throw new AppError(404, 'Server connection not found');

    const tpl = req.body.template ? validateTemplate(structuredClone(req.body.template)) : await loadTemplate(req, String(req.body.templateId));
    const opts: ApplyOptions = {
      wipeChannels: !!req.body.options?.wipeChannels,
      wipeGroups: !!req.body.options?.wipeGroups,
      applyServerSettings: req.body.options?.applyServerSettings !== false,
      icons: req.body.options?.icons !== false,
      tokens: req.body.options?.tokens !== false,
      dryRun: !!req.body.options?.dryRun,
    };
    req.setTimeout?.(10 * 60_000);
    const result = await new TemplateApplier(client, sid, server.host, opts).apply(tpl);
    console.log(`[ServerTemplates] ${opts.dryRun ? 'Preview' : 'Applied'} "${tpl.name}" on config ${configId}/sid ${sid}: ${result.created.channels} channels, ${result.created.serverGroups} groups`);
    res.json(result);
  } catch (err) { next(err); }
});

// POST …/server-templates/export  { name, save? }
serverTemplateRoutes.post('/export', async (req: Request, res: Response, next) => {
  try {
    const pool: ConnectionPool = req.app.locals.connectionPool;
    const client = pool.getClient(parseInt(String(req.params.configId)));
    const tpl = await exportServer(client, parseInt(String(req.params.sid)), String(req.body.name || 'My server').slice(0, 100));
    if (req.body.save) {
      const row = await req.app.locals.prisma.serverLayoutTemplate.create({
        data: { name: tpl.name, description: tpl.description, data: JSON.stringify(tpl) },
      });
      tpl.id = `saved-${row.id}`;
    }
    res.json(tpl);
  } catch (err) { next(err); }
});

// POST …/server-templates/icon  { target: 'servergroup'|'channelgroup'|'channel'|'server', id, icon?, color?, png? (base64) }
// Sets a built-in (or uploaded PNG) icon on an existing group, channel or the server itself.
serverTemplateRoutes.post('/icon', async (req: Request, res: Response, next) => {
  try {
    const configId = parseInt(String(req.params.configId));
    const sid = parseInt(String(req.params.sid));
    const pool: ConnectionPool = req.app.locals.connectionPool;
    const client = pool.getClient(configId);
    const server = await req.app.locals.prisma.tsServerConfig.findUnique({ where: { id: configId } });
    if (!server) throw new AppError(404, 'Server connection not found');

    const { target, id, icon, color, png } = req.body ?? {};
    let file: Buffer;
    let iconId: number;
    if (png) {
      file = Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64');
      if (!isPng(file)) throw new AppError(400, 'Icon must be a PNG under 64 KB (16×16 recommended)');
      iconId = crc32(file);
      // ids ≥ 2^31 are stored as negative signed values by the server
      if (iconId >= 0x80000000) iconId = iconId - 0x100000000;
    } else {
      if (!icon || !ICONS[icon]) throw new AppError(400, 'Unknown icon');
      const p = prepareIcon(icon, typeof color === 'string' && /^#[0-9a-f]{3,6}$/i.test(color) ? color : undefined);
      file = p.png;
      iconId = p.id;
    }

    const remove = icon === 'none';
    if (!remove) {
      try {
        await uploadFile(client, sid, server.host, `/icon_${iconId >>> 0}`, file);
      } catch (err: any) {
        throw new AppError(502, `Icon upload failed: ${err.message}. Is the file-transfer port 30033/TCP of the TS server reachable from the panel?`);
      }
    }

    const value = remove ? 0 : iconId;
    const numId = parseInt(String(id));
    switch (target) {
      case 'servergroup':
        await client.executePost(sid, 'servergroupaddperm', { sgid: numId, permsid: 'i_icon_id', permvalue: value, permnegated: 0, permskip: 0 });
        break;
      case 'channelgroup':
        await client.executePost(sid, 'channelgroupaddperm', { cgid: numId, permsid: 'i_icon_id', permvalue: value });
        break;
      case 'channel':
        await client.executePost(sid, 'channeladdperm', { cid: numId, permsid: 'i_icon_id', permvalue: value });
        break;
      case 'server':
        await client.executePost(sid, 'serveredit', { virtualserver_icon_id: value });
        break;
      default:
        throw new AppError(400, 'target must be servergroup, channelgroup, channel or server');
    }
    res.json({ success: true, iconId: value });
  } catch (err) { next(err); }
});
