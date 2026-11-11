import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LayoutTemplate, Hash, Lock, Mic, Users, Music2, Upload, Download, Trash2, Play, Eye, Loader2, Copy,
  CheckCircle2, AlertTriangle, XCircle, Info, Server, Save, FileJson, Wand2, KeyRound,
} from 'lucide-react';
import { useServerStore } from '@/stores/server.store';
import { useServerGroups, useChannelGroups } from '@/hooks/use-groups';
import { serverTemplatesApi, type ServerTemplate, type TplChannel, type ApplyOptions, type ApplyResult } from '@/api/server-templates.api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';

type IconMap = Record<string, { label: string; dataUrl: string }>;

const PRESET_LABEL: Record<string, string> = {
  admin: 'Full admin', moderator: 'Moderator', support: 'Support', vip: 'VIP', member: 'Member',
  dj: 'DJ', streamer: 'Streamer', bot: 'Bot', custom: 'Custom',
};

const SPACER_RE = /^\[([lrc*]?)spacer\d*\]/i;

function countChannels(list: TplChannel[]): number {
  return list.reduce((n, c) => n + (SPACER_RE.test(c.name) ? 0 : 1) + (c.children ? countChannels(c.children) : 0), 0);
}

function Icon({ icons, name, className }: { icons: IconMap; name?: string; className?: string }) {
  if (!name || !icons[name]) return null;
  return <img src={icons[name].dataUrl} alt={icons[name].label} className={cn('h-4 w-4 shrink-0 [image-rendering:pixelated]', className)} />;
}

// ─── Channel tree preview (looks like the TS client) ────────────────────────

function ChannelRow({ ch, icons, depth }: { ch: TplChannel; icons: IconMap; depth: number }) {
  const m = ch.name.match(SPACER_RE);
  if (m) {
    const text = ch.name.replace(SPACER_RE, '');
    const align = m[1] === 'l' ? 'justify-start' : m[1] === 'r' ? 'justify-end' : 'justify-center';
    return (
      <div className={cn('flex px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground', align)} style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="truncate">{text || '━━━━━━━━'}</span>
      </div>
    );
  }
  return (
    <>
      <div className="group flex items-center gap-1.5 rounded px-2 py-[3px] text-[13px] hover:bg-muted/50" style={{ paddingLeft: 8 + depth * 16 }}>
        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border', ch.isDefault ? 'border-primary bg-primary/20' : 'border-muted-foreground/40 bg-muted')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', ch.isDefault ? 'bg-primary' : 'bg-muted-foreground/50')} />
        </span>
        <span className="truncate">{ch.name}</span>
        {ch.isDefault && <Badge variant="outline" className="h-4 border-primary/40 px-1 text-[9px] text-primary">default</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          {ch.maxClients !== undefined && ch.maxClients >= 0 && <span className="flex items-center gap-0.5" title="Max clients"><Users className="h-3 w-3" />{ch.maxClients}</span>}
          {ch.codec === 5 && <span title="Opus Music"><Music2 className="h-3 w-3" /></span>}
          {!!ch.neededTalkPower && <span className="flex items-center gap-0.5" title="Moderated: needed talk power"><Mic className="h-3 w-3" />{ch.neededTalkPower}</span>}
          {(!!ch.neededJoinPower || ch.password) && <span className="flex items-center gap-0.5" title="Needed join power / password"><Lock className="h-3 w-3" />{ch.neededJoinPower || ''}</span>}
          <Icon icons={icons} name={ch.icon} />
        </span>
      </div>
      {ch.children?.map((c, i) => <ChannelRow key={i} ch={c} icons={icons} depth={depth + 1} />)}
    </>
  );
}

function TemplatePreview({ tpl, icons }: { tpl: ServerTemplate; icons: IconMap }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="rounded-xl border border-border bg-background/60">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium">
          <Server className="h-3.5 w-3.5 text-primary" />
          {tpl.server?.name || 'Your server'}
          <span className="ml-auto text-muted-foreground">{countChannels(tpl.channels)} channels</span>
        </div>
        <div className="max-h-[460px] overflow-y-auto py-1.5">
          {tpl.channels.map((c, i) => <ChannelRow key={i} ch={c} icons={icons} depth={0} />)}
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-background/60">
          <div className="border-b border-border px-3 py-2 text-xs font-medium">Server groups</div>
          <div className="space-y-0.5 p-1.5">
            {tpl.serverGroups.map((g) => (
              <div key={g.key} className="flex items-center gap-2 rounded px-2 py-1 text-[13px]">
                {g.icon ? <Icon icons={icons} name={g.icon} /> : <span className="h-4 w-4" />}
                <span className="truncate font-medium">{g.name}</span>
                {g.createToken && <span title="A token is created for this group"><KeyRound className="h-3 w-3 text-primary" /></span>}
                <Badge variant="outline" className="ml-auto h-4 px-1.5 text-[9px]">{PRESET_LABEL[g.preset] ?? g.preset}</Badge>
              </div>
            ))}
          </div>
        </div>
        {tpl.server?.welcomeMessage && (
          <div className="rounded-xl border border-border bg-background/60 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Welcome message</p>
            {tpl.server.welcomeMessage.replace(/\[\/?[a-z]+[^\]]*\]/gi, '')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Apply panel ────────────────────────────────────────────────────────────

const LOG_ICON = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />,
  warn: <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />,
  error: <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />,
  info: <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
};

function OptionRow({ label, hint, checked, onChange, danger }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2', danger && checked ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-muted/30')}>
      <div>
        <p className={cn('text-sm font-medium', danger && checked && 'text-destructive')}>{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

function ApplyPanel({ tpl }: { tpl: ServerTemplate }) {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const qc = useQueryClient();
  const [opts, setOpts] = useState<ApplyOptions>({ wipeChannels: false, wipeGroups: false, applyServerSettings: true, icons: true, tokens: true });
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof ApplyOptions) => (v: boolean) => setOpts((o) => ({ ...o, [k]: v }));

  const run = useMutation({
    mutationFn: (dryRun: boolean) => serverTemplatesApi.apply(c!, s!, {
      templateId: tpl.builtin || tpl.id.startsWith('saved-') ? tpl.id : undefined,
      template: tpl.builtin || tpl.id.startsWith('saved-') ? undefined : tpl,
      options: { ...opts, dryRun },
    }),
    onSuccess: (r, dryRun) => {
      setResult(r);
      if (!dryRun) {
        toast[r.success ? 'success' : 'warning'](r.success ? `Template applied – ${r.created.channels} channels, ${r.created.serverGroups} groups` : 'Applied with problems – see log');
        qc.invalidateQueries({ queryKey: ['channels'] });
        qc.invalidateQueries({ queryKey: ['server-groups'] });
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to apply template'),
  });

  if (!c || !s) return <p className="text-sm text-muted-foreground">Select a server at the top to apply this template.</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <OptionRow label="Icons" hint="Upload icons and set them on groups & channels" checked={!!opts.icons} onChange={set('icons')} />
        <OptionRow label="Server name & welcome message" hint="Overwrite name and welcome text" checked={!!opts.applyServerSettings} onChange={set('applyServerSettings')} />
        <OptionRow label="Create admin token" hint="Privilege key for the top group – use it to claim admin" checked={!!opts.tokens} onChange={set('tokens')} />
        <OptionRow label="Delete existing channels" hint="Removes ALL current channels; users are moved to the new lobby" checked={!!opts.wipeChannels} onChange={set('wipeChannels')} danger />
        <OptionRow label="Delete other groups" hint="Removes server groups that are not in the template (keeps Admin/Normal/Guest)" checked={!!opts.wipeGroups} onChange={set('wipeGroups')} danger />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => run.mutate(true)} disabled={run.isPending}>
          {run.isPending && run.variables === true ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview changes
        </Button>
        <Button onClick={() => (opts.wipeChannels || opts.wipeGroups ? setConfirm(true) : run.mutate(false))} disabled={run.isPending}>
          {run.isPending && run.variables === false ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Apply to server
        </Button>
        {run.isPending && <span className="self-center text-xs text-muted-foreground">This can take a minute – every permission is set individually.</span>}
      </div>

      {result && (
        <div className="space-y-3">
          {result.tokens.length > 0 && (
            <div className="rounded-xl border border-primary/40 bg-primary/[0.06] p-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-primary" /> Tokens</p>
              {result.tokens.map((t) => (
                <div key={t.token} className="flex items-center gap-2 text-xs">
                  <span className="w-28 shrink-0 font-medium">{t.group}</span>
                  <Input readOnly value={t.token} className="h-8 font-mono-data text-[11px]" />
                  <Button size="sm" variant="outline" className="h-8" onClick={() => { navigator.clipboard.writeText(t.token); toast.success('Copied'); }}><Copy className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
              <p className="mt-2 text-[11px] text-muted-foreground">In TeamSpeak: Permissions → Use Privilege Key → paste the token.</p>
            </div>
          )}
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border bg-background/60 p-3">
            {result.log.map((l, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">{LOG_ICON[l.level]}<span>{l.message}</span></div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Really replace the server layout?</DialogTitle>
            <DialogDescription>
              {opts.wipeChannels && 'All existing channels (incl. sub channels and their files) will be deleted. '}
              {opts.wipeGroups && 'Server groups that are not part of the template will be deleted. '}
              This cannot be undone. Tip: export the current server first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setConfirm(false); run.mutate(false); }}>Yes, apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Icon tool for existing groups ──────────────────────────────────────────

function IconPicker({ icons, value, onChange }: { icons: IconMap; value?: string; onChange: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(icons).map(([k, v]) => (
        <button key={k} title={v.label} onClick={() => onChange(k)}
          className={cn('grid h-7 w-7 place-items-center rounded-md border transition-colors', value === k ? 'border-primary bg-primary/15' : 'border-transparent hover:bg-muted')}>
          <img src={v.dataUrl} alt={v.label} className="h-4 w-4 [image-rendering:pixelated]" />
        </button>
      ))}
    </div>
  );
}

function IconTool({ icons }: { icons: IconMap }) {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data: sgs } = useServerGroups();
  const { data: cgs } = useChannelGroups();
  const [target, setTarget] = useState<{ kind: 'servergroup' | 'channelgroup' | 'server'; id: number; name: string } | null>(null);
  const [icon, setIcon] = useState<string>('star');
  const [color, setColor] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const setIconM = useMutation({
    mutationFn: (body: { icon?: string; png?: string }) => serverTemplatesApi.setIcon(c!, s!, { target: target!.kind, id: target!.id, color: color || undefined, ...body }),
    onSuccess: () => { toast.success(`Icon set for ${target?.name}`); qc.invalidateQueries({ queryKey: ['server-groups'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to set icon'),
  });
  if (!c || !s) return <EmptyState icon={Server} title="No server selected" />;

  const regular = (list: any) => (Array.isArray(list) ? list : []).filter((g: any) => String(g.type) === '1');
  const rows: { kind: 'servergroup' | 'channelgroup' | 'server'; id: number; name: string; group: string }[] = [
    { kind: 'server', id: 0, name: 'Server icon', group: 'Server' },
    ...regular(sgs).map((g: any) => ({ kind: 'servergroup' as const, id: parseInt(g.sgid), name: g.name, group: 'Server groups' })),
    ...regular(cgs).map((g: any) => ({ kind: 'channelgroup' as const, id: parseInt(g.cgid), name: g.name, group: 'Channel groups' })),
  ];

  const onFile = (f?: File) => {
    if (!f) return;
    if (f.size > 64 * 1024) { toast.error('Max. 64 KB'); return; }
    const r = new FileReader();
    r.onload = () => setIconM.mutate({ png: String(r.result) });
    r.readAsDataURL(f);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card>
        <CardContent className="max-h-[520px] space-y-0.5 overflow-y-auto p-2">
          {rows.map((r, i) => (
            <div key={`${r.kind}-${r.id}`}>
              {(i === 0 || rows[i - 1].group !== r.group) && <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{r.group}</p>}
              <button onClick={() => setTarget(r)}
                className={cn('w-full truncate rounded-md px-2 py-1.5 text-left text-sm', target?.kind === r.kind && target.id === r.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted')}>
                {r.name}
              </button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 p-5">
          {!target ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Pick a group (or the server) on the left.</p>
          ) : (
            <>
              <p className="text-sm">Icon for <span className="font-semibold">{target.name}</span></p>
              <IconPicker icons={icons} value={icon} onChange={setIcon} />
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label className="text-xs">Colour (optional)</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <input type="color" value={color || '#ff6a1a'} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent" />
                    {color && <Button size="sm" variant="ghost" className="h-8" onClick={() => setColor('')}>Default</Button>}
                  </div>
                </div>
                <Button onClick={() => setIconM.mutate({ icon })} disabled={setIconM.isPending}>
                  {setIconM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Set icon
                </Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={setIconM.isPending}><Upload className="h-4 w-4" /> Own PNG</Button>
                <Button variant="ghost" onClick={() => setIconM.mutate({ icon: 'none' })} disabled={setIconM.isPending}>Remove icon</Button>
                <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </div>
              <p className="text-[11px] text-muted-foreground">Icons are uploaded through the TeamSpeak file transfer (port 30033/TCP). Own icons: PNG, ideally 16×16 px.</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ServerTemplates() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['server-templates'], queryFn: serverTemplatesApi.list, staleTime: 60_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportName, setExportName] = useState('My server');
  const [importText, setImportText] = useState('');

  const icons = data?.icons ?? {};
  const templates = data?.templates ?? [];
  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? templates[0], [templates, selectedId]);

  const exportM = useMutation({
    mutationFn: () => serverTemplatesApi.exportServer(c!, s!, exportName, true),
    onSuccess: (t) => { toast.success(`Saved as template “${t.name}”`); setExportOpen(false); qc.invalidateQueries({ queryKey: ['server-templates'] }); setSelectedId(t.id); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Export failed'),
  });
  const importM = useMutation({
    mutationFn: (t: ServerTemplate) => serverTemplatesApi.save(t),
    onSuccess: (r) => { toast.success('Template imported'); setImportOpen(false); setImportText(''); qc.invalidateQueries({ queryKey: ['server-templates'] }); setSelectedId(r.id); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Import failed'),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => serverTemplatesApi.remove(id),
    onSuccess: () => { toast.success('Template deleted'); setSelectedId(null); qc.invalidateQueries({ queryKey: ['server-templates'] }); },
  });
  const copyM = useMutation({
    mutationFn: (t: ServerTemplate) => serverTemplatesApi.save({ ...t, name: `${t.name} (copy)` }),
    onSuccess: (r) => { toast.success('Copy saved – edit it via Download/Import JSON'); qc.invalidateQueries({ queryKey: ['server-templates'] }); setSelectedId(r.id); },
  });

  const download = (t: ServerTemplate) => {
    const { builtin: _b, ...clean } = t;
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t.name.replace(/[^\w-]+/g, '_')}.ts6-template.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = () => {
    try {
      const t = JSON.parse(importText);
      importM.mutate(t);
    } catch {
      toast.error('That is not valid JSON');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Server</p>
          <h1 className="text-2xl font-bold">Server Templates</h1>
          <p className="text-sm text-muted-foreground">Complete layouts – channels, spacers, groups, permissions and icons – in one click.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}><FileJson className="h-4 w-4" /> Import JSON</Button>
          <Button variant="outline" onClick={() => setExportOpen(true)} disabled={!c || !s}><Save className="h-4 w-4" /> Save current server as template</Button>
        </div>
      </div>

      <Tabs defaultValue="templates" className="space-y-4">
        <TabsList>
          <TabsTrigger value="templates"><LayoutTemplate className="mr-1.5 h-3.5 w-3.5" /> Templates</TabsTrigger>
          <TabsTrigger value="icons"><Wand2 className="mr-1.5 h-3.5 w-3.5" /> Icons for groups</TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="space-y-4">
          {isLoading ? <div className="h-40 animate-pulse rounded-xl bg-muted/40" /> : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                {templates.map((t) => (
                  <button key={t.id} onClick={() => setSelectedId(t.id)}
                    className={cn('relative overflow-hidden rounded-xl border bg-card p-4 text-left transition-all',
                      selected?.id === t.id ? 'border-primary/60 shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]' : 'border-border hover:border-foreground/20')}>
                    <span className="absolute inset-x-0 top-0 h-1" style={{ background: t.accent || 'hsl(var(--primary))' }} />
                    <div className="mb-2 flex items-center gap-2">
                      <p className="truncate font-semibold">{t.name}</p>
                      {!t.builtin && <Badge variant="outline" className="h-4 px-1.5 text-[9px]">saved</Badge>}
                    </div>
                    <p className="line-clamp-2 min-h-[32px] text-xs text-muted-foreground">{t.description}</p>
                    <div className="mt-3 flex items-center gap-1">
                      {t.serverGroups.slice(0, 7).map((g) => <Icon key={g.key} icons={icons} name={g.icon} />)}
                      <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-0.5"><Hash className="h-3 w-3" />{countChannels(t.channels)}</span>
                        <span className="flex items-center gap-0.5"><Users className="h-3 w-3" />{t.serverGroups.length}</span>
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {selected && (
                <Card>
                  <CardContent className="space-y-5 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold">{selected.name}</h2>
                      <div className="ml-auto flex flex-wrap gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => download(selected)}><Download className="h-3.5 w-3.5" /> JSON</Button>
                        {selected.builtin && <Button size="sm" variant="outline" onClick={() => copyM.mutate(selected)}><Copy className="h-3.5 w-3.5" /> Save copy</Button>}
                        {!selected.builtin && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeM.mutate(selected.id)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>}
                      </div>
                    </div>
                    <TemplatePreview tpl={selected} icons={icons} />
                    <ApplyPanel key={selected.id} tpl={selected} />
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="icons"><IconTool icons={icons} /></TabsContent>
      </Tabs>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save current server as template</DialogTitle>
            <DialogDescription>Saves channel tree, groups and their permissions. Handy as a backup before applying another template.</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={exportName} onChange={(e) => setExportName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>Cancel</Button>
            <Button onClick={() => exportM.mutate()} disabled={exportM.isPending || !exportName.trim()}>
              {exportM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Import template</DialogTitle>
            <DialogDescription>Paste a template JSON (e.g. a downloaded one you edited) or pick a file.</DialogDescription>
          </DialogHeader>
          <input type="file" accept="application/json,.json" className="text-xs"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setImportText); }} />
          <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={12} className="font-mono-data text-[11px]" placeholder='{ "name": "...", "serverGroups": [...], "channels": [...] }' />
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button onClick={doImport} disabled={!importText.trim() || importM.isPending}><Upload className="h-4 w-4" /> Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
