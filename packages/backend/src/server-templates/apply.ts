import type { WebQueryClient } from '../ts-client/webquery-client.js';
import { PRESET_PERMS } from './builtin.js';
import { prepareIcon } from './icons.js';
import { uploadFile, listIcons } from './file-transfer.js';
import type {
  ApplyOptions, ApplyResult, ServerTemplate, TemplateChannel, TemplateServerGroup, TemplateChannelGroup,
} from './types.js';

type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arr = (r: any): Row[] => (Array.isArray(r) ? r : r ? [r] : []);
const num = (v: any) => parseInt(String(v ?? '0'), 10) || 0;

/**
 * Applies a ServerTemplate to a virtual server through WebQuery.
 * Idempotent where possible: groups/channels with the same name are reused and updated.
 */
export class TemplateApplier {
  private result: ApplyResult = { success: true, log: [], created: { serverGroups: 0, channelGroups: 0, channels: 0, icons: 0 }, tokens: [] };
  private iconIds = new Map<string, number>();
  private spacerCounter = 0;

  constructor(
    private client: WebQueryClient,
    private sid: number,
    private host: string,
    private opts: ApplyOptions,
  ) { }

  private log(level: ApplyResult['log'][number]['level'], message: string) {
    this.result.log.push({ level, message });
    if (level === 'error') this.result.success = false;
  }

  private get dry() { return !!this.opts.dryRun; }

  private lastCall = 0;

  /**
   * Throttled + retried WebQuery call. Applying a template sends hundreds of commands;
   * without a pause the TS flood protection drops the connection ("socket hang up").
   */
  private async call(cmd: string, params: Record<string, any>): Promise<any> {
    const MIN_GAP_MS = 140; // ≈ 7 commands/s – below the default query flood limit
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      try {
        // Reads via GET (like the rest of the panel), writes via POST
        return /(list|info)$/.test(cmd)
          ? await this.client.execute(this.sid, cmd, params)
          : await this.client.executePost(this.sid, cmd, params);
      } catch (err: any) {
        const msg = String(err?.message ?? '');
        const network = err?.code === -1 || /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|timeout|Connection failed/i.test(msg);
        const flood = err?.code === 524 || /flood/i.test(msg);
        if ((network || flood) && attempt < 5) {
          const backoff = flood ? 4000 : 1000 * 2 ** attempt;
          if (attempt === 0) this.log('warn', `Server is throttling (${msg || 'connection reset'}) – slowing down and retrying…`);
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  }

  async apply(tpl: ServerTemplate): Promise<ApplyResult> {
    this.log('info', `${this.dry ? 'Preview of' : 'Applying'} template "${tpl.name}"`);
    try {
      const info = arr(await this.call('serverinfo', {}))[0] ?? {};
      const groups = arr(await this.call('servergrouplist', {}));
      const cgroups = arr(await this.call('channelgrouplist', {}));

      if (this.opts.icons !== false) await this.prepareIcons(tpl);

      const sgMap = await this.applyServerGroups(tpl.serverGroups, groups, info);
      if (tpl.channelGroups?.length) await this.applyChannelGroups(tpl.channelGroups, cgroups, info);
      if (this.opts.wipeGroups) await this.wipeGroups(tpl, groups, info);

      await this.applyChannels(tpl.channels);

      if (this.opts.applyServerSettings && tpl.server) await this.applyServerSettings(tpl);
      if (this.opts.tokens !== false) await this.createTokens(tpl.serverGroups, sgMap);

      this.log(this.result.success ? 'ok' : 'warn', this.dry ? 'Preview finished – nothing was changed.' : 'Template applied.');
    } catch (err: any) {
      this.log('error', `Aborted: ${err.message}`);
    }
    return this.result;
  }

  // ─── Icons ───────────────────────────────────────────────────

  private async prepareIcons(tpl: ServerTemplate) {
    const wanted = new Map<string, { key: string; color?: string }>();
    const add = (key?: string, color?: string) => { if (key) wanted.set(`${key}|${color ?? ''}`, { key, color }); };
    tpl.serverGroups.forEach((g) => add(g.icon, g.iconColor));
    tpl.channelGroups?.forEach((g) => add(g.icon, g.iconColor));
    const walk = (cs: TemplateChannel[]) => cs.forEach((c) => { add(c.icon, c.iconColor); if (c.children) walk(c.children); });
    walk(tpl.channels);
    if (wanted.size === 0) return;

    const existing = this.dry ? new Set<number>() : await listIcons(this.client, this.sid);
    for (const [ref, { key, color }] of wanted) {
      try {
        const icon = prepareIcon(key, color);
        if (!this.dry && !existing.has(icon.id)) {
          await uploadFile(this.client, this.sid, this.host, `/icon_${icon.id}`, icon.png);
          this.result.created.icons++;
        }
        this.iconIds.set(ref, icon.id);
      } catch (err: any) {
        const scope = /scope/i.test(String(err.message));
        this.log('warn', scope
          ? `Icons skipped: the WebQuery API key is not allowed to upload files ("${err.message}"). Create an API key with scope "manage" (see help) and update it under Settings → Connections.`
          : `Icon "${key}" could not be uploaded (${err.message}). Is the file-transfer port (30033/TCP) reachable from the panel? Continuing without icons.`);
        this.iconIds.clear();
        return;
      }
    }
    this.log('ok', `Icons ready (${wanted.size}${this.result.created.icons ? `, ${this.result.created.icons} uploaded` : ''})`);
  }

  private iconFor(key?: string, color?: string): number | undefined {
    return key ? this.iconIds.get(`${key}|${color ?? ''}`) : undefined;
  }

  // ─── Server groups ───────────────────────────────────────────

  private async applyServerGroups(list: TemplateServerGroup[], groups: Row[], info: Row): Promise<Map<string, number>> {
    const regular = groups.filter((g) => num(g.type) === 1);
    const defaultSg = num(info.virtualserver_default_server_group);
    const adminSrc = regular.find((g) => /server\s*admin/i.test(g.name)) ?? regular.find((g) => num(g.sgid) === 6);
    const normalSrc = regular.find((g) => /^normal$/i.test(g.name)) ?? regular.find((g) => num(g.sgid) === 7) ?? regular.find((g) => num(g.sgid) === defaultSg);
    if (!normalSrc) throw new Error('Could not find a base server group ("Normal" / default group) to copy from');

    const map = new Map<string, number>();
    for (const g of list) {
      const existing = regular.find((x) => x.name === g.name);
      let sgid = existing ? num(existing.sgid) : 0;
      if (!existing) {
        const src = g.preset === 'admin' && adminSrc ? adminSrc : normalSrc;
        if (this.dry) {
          this.log('info', `Would create server group "${g.name}" (${g.preset}, copy of "${src.name}")`);
          map.set(g.key, -1);
          continue;
        }
        const res = arr(await this.call('servergroupcopy', { ssgid: num(src.sgid), tsgid: 0, name: g.name, type: 1 }))[0];
        sgid = num(res?.sgid);
        if (!sgid) { this.log('error', `Server group "${g.name}" could not be created`); continue; }
        this.result.created.serverGroups++;
        this.log('ok', `Server group "${g.name}" created (sgid ${sgid})`);
      } else {
        this.log('info', `Server group "${g.name}" exists (sgid ${sgid}) – updating`);
        if (this.dry) { map.set(g.key, sgid); continue; }
      }
      map.set(g.key, sgid);

      const perms: Record<string, number> = { ...PRESET_PERMS[g.preset], ...(g.extraPerms ?? {}) };
      if (g.sortId !== undefined) perms.i_group_sort_id = g.sortId;
      if (g.showName !== undefined) perms.i_group_show_name_in_tree = g.showName;
      const icon = this.iconFor(g.icon, g.iconColor);
      if (icon) perms.i_icon_id = icon;
      await this.addPerms('servergroupaddperm', { sgid }, perms, `group "${g.name}"`);
    }
    return map;
  }

  private async applyChannelGroups(list: TemplateChannelGroup[], cgroups: Row[], info: Row) {
    const regular = cgroups.filter((g) => num(g.type) === 1);
    const src = {
      channel_admin: regular.find((g) => num(g.cgid) === num(info.virtualserver_default_channel_admin_group)) ?? regular.find((g) => /admin/i.test(g.name)),
      channel_operator: regular.find((g) => /operator/i.test(g.name)),
      channel_guest: regular.find((g) => num(g.cgid) === num(info.virtualserver_default_channel_group)) ?? regular.find((g) => /guest/i.test(g.name)),
    };
    for (const g of list) {
      const existing = regular.find((x) => x.name === g.name);
      let cgid = existing ? num(existing.cgid) : 0;
      if (!existing) {
        const base = src[g.preset] ?? src.channel_guest;
        if (!base) { this.log('warn', `No base channel group for "${g.name}"`); continue; }
        if (this.dry) { this.log('info', `Would create channel group "${g.name}"`); continue; }
        const res = arr(await this.call('channelgroupcopy', { scgid: num(base.cgid), tcgid: 0, name: g.name, type: 1 }))[0];
        cgid = num(res?.cgid);
        if (!cgid) { this.log('error', `Channel group "${g.name}" could not be created`); continue; }
        this.result.created.channelGroups++;
        this.log('ok', `Channel group "${g.name}" created`);
      } else if (this.dry) {
        continue;
      }
      const perms: Record<string, number> = { ...(g.extraPerms ?? {}) };
      if (g.sortId !== undefined) perms.i_group_sort_id = g.sortId;
      const icon = this.iconFor(g.icon, g.iconColor);
      if (icon) perms.i_icon_id = icon;
      await this.addPerms('channelgroupaddperm', { cgid }, perms, `channel group "${g.name}"`);
    }
  }

  private async wipeGroups(tpl: ServerTemplate, groups: Row[], info: Row) {
    const keep = new Set(tpl.serverGroups.map((g) => g.name));
    const defaultSg = num(info.virtualserver_default_server_group);
    for (const g of groups.filter((x) => num(x.type) === 1)) {
      const sgid = num(g.sgid);
      // Never delete the default group or the built-in base groups we copy from
      if (keep.has(g.name) || sgid === defaultSg || /server\s*admin|^normal$|^guest$/i.test(g.name)) continue;
      if (this.dry) { this.log('info', `Would delete server group "${g.name}"`); continue; }
      try {
        await this.call('servergroupdel', { sgid, force: 1 });
        this.log('ok', `Deleted server group "${g.name}"`);
      } catch (err: any) {
        this.log('warn', `Could not delete group "${g.name}": ${err.message}`);
      }
    }
  }

  private async addPerms(cmd: string, target: Record<string, any>, perms: Record<string, number>, label: string) {
    let failed = 0;
    for (const [permsid, value] of Object.entries(perms)) {
      try {
        await this.call(cmd, { ...target, permsid, permvalue: value, permnegated: 0, permskip: 0 });
      } catch {
        failed++;
      }
    }
    if (failed) this.log('warn', `${failed} permission(s) not supported by this server for ${label}`);
  }

  // ─── Channels ────────────────────────────────────────────────

  private async applyChannels(tree: TemplateChannel[]) {
    let existing = arr(await this.call('channellist', { '-flags': '' }));
    let oldDefault: Row | undefined;

    if (this.opts.wipeChannels) {
      oldDefault = existing.find((c) => num(c.channel_flag_default) === 1);
      const toDelete = existing.filter((c) => num(c.pid) === 0 && c !== oldDefault);
      if (this.dry) {
        this.log('info', `Would delete ${existing.length} existing channel(s)`);
        existing = [];
      } else {
        for (const c of toDelete) {
          try { await this.call('channeldelete', { cid: num(c.cid), force: 1 }); } catch (err: any) { this.log('warn', `Could not delete "${c.channel_name}": ${err.message}`); }
        }
        if (oldDefault) {
          // Free the name and drop its sub channels – it is removed after the new default exists
          for (const sub of existing.filter((c) => num(c.pid) === num(oldDefault!.cid))) {
            try { await this.call('channeldelete', { cid: num(sub.cid), force: 1 }); } catch { /* ignore */ }
          }
          try { await this.call('channeledit', { cid: num(oldDefault.cid), channel_name: `__old_default_${Date.now()}` }); } catch { /* ignore */ }
        }
        this.log('ok', `Removed ${toDelete.length + (oldDefault ? 1 : 0)} old channel(s)`);
        existing = arr(await this.call('channellist', { '-flags': '' }));
      }
    }

    if (!tree.some((c) => c.isDefault) && tree.length) {
      const first = tree.find((c) => !/^\[[^\]]*spacer/i.test(c.name)) ?? tree[0];
      first.isDefault = true;
    }

    await this.createLevel(tree, 0, existing);

    if (oldDefault && !this.dry) {
      try {
        await this.call('channeldelete', { cid: num(oldDefault.cid), force: 1 });
      } catch (err: any) {
        this.log('warn', `Old default channel could not be removed (${err.message}) – delete it manually`);
      }
    }
  }

  private normalizeName(name: string): string {
    // "[cspacer]Text" → "[cspacer12]Text" so equal spacer texts never collide
    return name.replace(/^\[([lrc*]?)spacer\d*\]/i, (_m, a) => `[${a}spacer${this.spacerCounter++}]`).slice(0, 40);
  }

  private async createLevel(list: TemplateChannel[], parent: number, existing: Row[]) {
    let order = 0;
    for (const ch of list) {
      const isSpacer = /^\[[lrc*]?spacer\d*\]/i.test(ch.name);
      const spacerText = ch.name.replace(/^\[[lrc*]?spacer\d*\]/i, '');
      const match = existing.find((c) => num(c.pid) === parent && (c.channel_name === ch.name ||
        (isSpacer && /^\[[lrc*]?spacer\d*\]/i.test(c.channel_name) && c.channel_name.replace(/^\[[lrc*]?spacer\d*\]/i, '') === spacerText)));
      const name = match ? match.channel_name : this.normalizeName(ch.name);

      const props: Record<string, any> = {
        channel_topic: ch.topic,
        channel_description: ch.description,
        channel_codec: ch.codec,
        channel_codec_quality: ch.quality,
        channel_needed_talk_power: ch.neededTalkPower,
        channel_password: ch.password,
      };
      if (ch.maxClients !== undefined && ch.maxClients >= 0) {
        props.channel_maxclients = ch.maxClients;
        props.channel_flag_maxclients_unlimited = 0;
      }
      if (ch.isDefault) props.channel_flag_default = 1;

      let cid = match ? num(match.cid) : 0;
      if (this.dry) {
        this.log('info', `${match ? 'Would update' : 'Would create'} channel ${'  '.repeat(parent ? 1 : 0)}"${name}"`);
      } else if (match) {
        const edit = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
        if (Object.keys(edit).length) {
          try { await this.call('channeledit', { cid, ...edit }); } catch (err: any) { this.log('warn', `Could not update "${name}": ${err.message}`); }
        }
      } else {
        try {
          const res = arr(await this.call('channelcreate', {
            channel_name: name,
            ...props,
            channel_flag_permanent: ch.semiPermanent ? 0 : 1,
            channel_flag_semi_permanent: ch.semiPermanent ? 1 : 0,
            cpid: parent,
            channel_order: order,
          }))[0];
          cid = num(res?.cid);
          this.result.created.channels++;
        } catch (err: any) {
          this.log('error', `Channel "${name}" could not be created: ${err.message}`);
          continue;
        }
      }

      if (cid && !this.dry) {
        const perms: Record<string, number> = {};
        if (ch.neededJoinPower) perms.i_channel_needed_join_power = ch.neededJoinPower;
        if (ch.neededSubscribePower) perms.i_channel_needed_subscribe_power = ch.neededSubscribePower;
        const icon = this.iconFor(ch.icon, ch.iconColor);
        if (icon) perms.i_icon_id = icon;
        await this.addPerms('channeladdperm', { cid }, perms, `channel "${name}"`);
        order = cid;
      }

      if (ch.children?.length) await this.createLevel(ch.children, cid || -1, existing);
    }
    if (!this.dry && parent === 0) this.log('ok', `Channels: ${this.result.created.channels} created`);
  }

  // ─── Server settings & tokens ───────────────────────────────

  private async applyServerSettings(tpl: ServerTemplate) {
    const s = tpl.server!;
    const params: Record<string, any> = {
      virtualserver_name: s.name,
      virtualserver_welcomemessage: s.welcomeMessage,
      virtualserver_hostmessage: s.hostMessage,
      virtualserver_hostmessage_mode: s.hostMessageMode,
      virtualserver_maxclients: s.maxClients,
    };
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) return;
    if (this.dry) { this.log('info', `Would update server settings (${Object.keys(clean).join(', ')})`); return; }
    try {
      await this.call('serveredit', clean);
      this.log('ok', 'Server name / welcome message updated');
    } catch (err: any) {
      this.log('warn', `Server settings not applied: ${err.message}`);
    }
  }

  private async createTokens(groups: TemplateServerGroup[], map: Map<string, number>) {
    for (const g of groups.filter((x) => x.createToken)) {
      const sgid = map.get(g.key);
      if (!sgid || sgid < 0) continue;
      if (this.dry) { this.log('info', `Would create a token for "${g.name}"`); continue; }
      try {
        const res = arr(await this.call('privilegekeyadd', { tokentype: 0, tokenid1: sgid, tokenid2: 0, tokendescription: `Template: ${g.name}` }))[0];
        if (res?.token) {
          this.result.tokens.push({ group: g.name, token: res.token });
          this.log('ok', `Token for "${g.name}" created`);
        }
      } catch (err: any) {
        this.log('warn', `Token for "${g.name}" could not be created: ${err.message}`);
      }
    }
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────

/** Snapshot the current server layout as a template (groups + channel tree). */
export async function exportServer(client: WebQueryClient, sid: number, name: string): Promise<ServerTemplate> {
  const info = arr(await client.execute(sid, 'serverinfo'))[0] ?? {};
  const groups = arr(await client.execute(sid, 'servergrouplist')).filter((g) => num(g.type) === 1);
  const defaultSg = num(info.virtualserver_default_server_group);
  const channels = arr(await client.execute(sid, 'channellist', { '-topic': '', '-flags': '', '-voice': '', '-limits': '' }));

  const serverGroups: TemplateServerGroup[] = [];
  for (const g of groups) {
    const sgid = num(g.sgid);
    if (sgid === defaultSg || /^guest$/i.test(g.name)) continue;
    const isAdmin = /server\s*admin/i.test(g.name);
    let extraPerms: Record<string, number> = {};
    if (!isAdmin) {
      try {
        const perms = arr(await client.execute(sid, 'servergrouppermlist', { sgid, '-permsid': '' }));
        for (const p of perms) {
          if (!p.permsid || p.permsid === 'i_icon_id') continue;
          extraPerms[p.permsid] = num(p.permvalue);
        }
      } catch { extraPerms = {}; }
    }
    serverGroups.push({
      key: `g${sgid}`,
      name: g.name,
      preset: isAdmin ? 'admin' : 'custom',
      sortId: g.sortid !== undefined ? num(g.sortid) : undefined,
      extraPerms: Object.keys(extraPerms).length ? extraPerms : undefined,
    });
  }

  const byParent = new Map<number, Row[]>();
  for (const c of channels) {
    const pid = num(c.pid);
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(c);
  }
  // channel_order = cid of the channel above
  const sortSiblings = (list: Row[]) => {
    const out: Row[] = [];
    let prev = 0;
    const rest = [...list];
    while (rest.length) {
      const idx = rest.findIndex((c) => num(c.channel_order) === prev);
      const next = idx >= 0 ? rest.splice(idx, 1)[0] : rest.shift()!;
      out.push(next);
      prev = num(next.cid);
    }
    return out;
  };

  const build = async (pid: number): Promise<TemplateChannel[]> => {
    const list = sortSiblings(byParent.get(pid) ?? []);
    const out: TemplateChannel[] = [];
    for (const c of list) {
      const ch: TemplateChannel = { name: String(c.channel_name).replace(/^\[([lrc*]?)spacer\d*\]/i, '[$1spacer]') };
      if (c.channel_topic) ch.topic = c.channel_topic;
      if (num(c.channel_flag_default) === 1) ch.isDefault = true;
      if (num(c.channel_flag_permanent) !== 1 && num(c.channel_flag_semi_permanent) === 1) ch.semiPermanent = true;
      if (c.channel_codec !== undefined) ch.codec = num(c.channel_codec) === 5 ? 5 : 4;
      if (c.channel_codec_quality !== undefined) ch.quality = num(c.channel_codec_quality);
      if (num(c.channel_needed_talk_power) > 0) ch.neededTalkPower = num(c.channel_needed_talk_power);
      if (c.channel_maxclients !== undefined && num(c.channel_maxclients) > 0 && num(c.channel_flag_maxclients_unlimited) !== 1) ch.maxClients = num(c.channel_maxclients);
      try {
        const perms = arr(await client.execute(sid, 'channelpermlist', { cid: num(c.cid), '-permsid': '' }));
        const join = perms.find((p) => p.permsid === 'i_channel_needed_join_power');
        if (join && num(join.permvalue) > 0) ch.neededJoinPower = num(join.permvalue);
      } catch { /* no perms */ }
      const kids = await build(num(c.cid));
      if (kids.length) ch.children = kids;
      out.push(ch);
    }
    return out;
  };

  return {
    id: `export-${Date.now()}`,
    name,
    description: `Exported from "${info.virtualserver_name ?? 'server'}" on ${new Date().toLocaleDateString('de-DE')}`,
    category: 'custom',
    server: {
      name: info.virtualserver_name,
      welcomeMessage: info.virtualserver_welcomemessage || undefined,
    },
    serverGroups,
    channels: await build(0),
  };
}
