import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { MusicBotSummary } from '@ts6/common';
import { useCreateMusicBot, useUpdateMusicBot } from '@/hooks/use-music-bots';
import { useServers } from '@/hooks/use-servers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const EMPTY = {
  name: '', serverConfigId: '', nickname: 'MusicBot', serverPassword: '', defaultChannel: '', channelPassword: '',
  voicePort: 9987, volume: 40, autoStart: true,
  normalize: true, autoplay: false, announce: true, autoPauseEmpty: true, nowPlayingNick: true,
  commandPrefix: '!', defaultSearch: 'youtube' as 'youtube' | 'soundcloud',
};

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 px-3 py-2.5 transition-colors hover:bg-muted/50">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

export function BotFormDialog({ open, bot, onClose }: { open: boolean; bot: MusicBotSummary | null; onClose: () => void }) {
  const { data: servers } = useServers();
  const createBot = useCreateMusicBot();
  const updateBot = useUpdateMusicBot();
  const [form, setForm] = useState(EMPTY);
  const serverList = Array.isArray(servers) ? servers : [];
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) return;
    if (bot) {
      setForm({
        name: bot.name,
        serverConfigId: String(bot.serverConfigId),
        nickname: bot.nickname,
        serverPassword: bot.serverPassword || '',
        defaultChannel: bot.defaultChannel || '',
        channelPassword: bot.channelPassword || '',
        voicePort: bot.voicePort ?? 9987,
        volume: bot.volume,
        autoStart: bot.autoStart,
        normalize: bot.normalize ?? true,
        autoplay: bot.autoplay ?? false,
        announce: bot.announce ?? true,
        autoPauseEmpty: bot.autoPauseEmpty ?? true,
        nowPlayingNick: bot.nowPlayingNick ?? true,
        commandPrefix: bot.commandPrefix || '!',
        defaultSearch: bot.defaultSearch === 'soundcloud' ? 'soundcloud' : 'youtube',
      });
    } else {
      setForm({ ...EMPTY, serverConfigId: serverList[0] ? String(serverList[0].id) : '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot?.id]);

  const submit = () => {
    const payload = {
      ...form,
      serverConfigId: parseInt(form.serverConfigId),
      nickname: form.nickname || 'MusicBot',
      serverPassword: form.serverPassword || undefined,
      defaultChannel: form.defaultChannel || undefined,
      channelPassword: form.channelPassword || undefined,
    };
    if (bot) {
      updateBot.mutate({ id: bot.id, data: payload }, {
        onSuccess: () => { toast.success('Bot saved'); onClose(); },
        onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to save bot'),
      });
    } else {
      if (!payload.serverConfigId) { toast.error('Please select a server'); return; }
      createBot.mutate(payload, {
        onSuccess: () => { toast.success('Music bot created — generating identity can take a few seconds'); onClose(); },
        onError: (e: any) => toast.error(e?.response?.data?.error || 'Failed to create bot'),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{bot ? `Edit ${bot.name}` : 'New music bot'}</DialogTitle>
          <DialogDescription>Connection details and how the bot behaves in the channel.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="connection">
          <TabsList className="w-full">
            <TabsTrigger value="connection" className="flex-1">Connection</TabsTrigger>
            <TabsTrigger value="behaviour" className="flex-1">Behaviour</TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <Label className="text-xs">Name</Label>
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Lounge Bot" />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <Label className="text-xs">Nickname in TeamSpeak</Label>
                <Input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="MusicBot" />
              </div>
            </div>
            {!bot && (
              <div>
                <Label className="text-xs">Server</Label>
                <Select value={form.serverConfigId} onValueChange={(v) => set('serverConfigId', v)}>
                  <SelectTrigger><SelectValue placeholder="Select server…" /></SelectTrigger>
                  <SelectContent>
                    {serverList.map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.host})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Voice port</Label>
                <Input type="number" value={form.voicePort} onChange={(e) => set('voicePort', parseInt(e.target.value) || 9987)} />
              </div>
              <div>
                <Label className="text-xs">Server password</Label>
                <Input type="password" value={form.serverPassword} onChange={(e) => set('serverPassword', e.target.value)} placeholder="optional" />
              </div>
              <div>
                <Label className="text-xs">Default channel</Label>
                <Input value={form.defaultChannel} onChange={(e) => set('defaultChannel', e.target.value)} placeholder="Name or ID" />
              </div>
              <div>
                <Label className="text-xs">Channel password</Label>
                <Input type="password" value={form.channelPassword} onChange={(e) => set('channelPassword', e.target.value)} placeholder="optional" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Start volume · {form.volume}%</Label>
              <Slider className="mt-2" value={[form.volume]} max={100} step={1} onValueChange={([v]) => set('volume', v)} />
            </div>
            <ToggleRow label="Auto-start" hint="Connect automatically when the panel starts" checked={form.autoStart} onChange={(v) => set('autoStart', v)} />
          </TabsContent>

          <TabsContent value="behaviour" className="space-y-2 pt-2">
            <div className="grid grid-cols-2 gap-3 pb-1">
              <div>
                <Label className="text-xs">Search with</Label>
                <Select value={form.defaultSearch} onValueChange={(v) => set('defaultSearch', v as 'youtube' | 'soundcloud')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="youtube">YouTube</SelectItem>
                    <SelectItem value="soundcloud">SoundCloud</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground">Used for <code>!play some text</code></p>
              </div>
              <div>
                <Label className="text-xs">Command prefix</Label>
                <Input value={form.commandPrefix} maxLength={3} onChange={(e) => set('commandPrefix', e.target.value)} className="font-mono-data" />
                <p className="mt-1 text-[11px] text-muted-foreground">e.g. <code>{form.commandPrefix || '!'}play</code></p>
              </div>
            </div>
            <ToggleRow label="Autoplay" hint="Keep playing related tracks (YouTube Mix / SoundCloud recommended) when the queue ends" checked={form.autoplay} onChange={(v) => set('autoplay', v)} />
            <ToggleRow label="Loudness normalization" hint="Evens out quiet and loud tracks" checked={form.normalize} onChange={(v) => set('normalize', v)} />
            <ToggleRow label="Announce tracks in channel" hint="Posts “Now playing …” with link into the channel chat" checked={form.announce} onChange={(v) => set('announce', v)} />
            <ToggleRow label="Pause when channel is empty" hint="Resumes automatically when someone joins" checked={form.autoPauseEmpty} onChange={(v) => set('autoPauseEmpty', v)} />
            <ToggleRow label="Track in nickname" hint="Shows “MusicBot ♪ Title” as nickname" checked={form.nowPlayingNick} onChange={(v) => set('nowPlayingNick', v)} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!form.name || (!bot && !form.serverConfigId) || createBot.isPending || updateBot.isPending}>
            {bot ? 'Save' : 'Create bot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
