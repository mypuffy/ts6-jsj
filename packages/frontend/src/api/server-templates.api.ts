import api from './client';

export interface TplChannel {
  name: string;
  topic?: string;
  maxClients?: number;
  codec?: 4 | 5;
  quality?: number;
  isDefault?: boolean;
  neededTalkPower?: number;
  neededJoinPower?: number;
  icon?: string;
  iconColor?: string;
  password?: string;
  children?: TplChannel[];
}

export interface TplGroup {
  key: string;
  name: string;
  preset: string;
  icon?: string;
  iconColor?: string;
  sortId?: number;
  createToken?: boolean;
  extraPerms?: Record<string, number>;
}

export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  accent?: string;
  builtin?: boolean;
  server?: { name?: string; welcomeMessage?: string; hostMessage?: string };
  serverGroups: TplGroup[];
  channelGroups?: TplGroup[];
  channels: TplChannel[];
}

export interface ApplyOptions {
  wipeChannels?: boolean;
  wipeGroups?: boolean;
  applyServerSettings?: boolean;
  icons?: boolean;
  tokens?: boolean;
  dryRun?: boolean;
}

export interface ApplyResult {
  success: boolean;
  log: { level: 'info' | 'ok' | 'warn' | 'error'; message: string }[];
  created: { serverGroups: number; channelGroups: number; channels: number; icons: number };
  tokens: { group: string; token: string }[];
}

const vs = (c: number, s: number) => `/servers/${c}/vs/${s}/server-templates`;

export const serverTemplatesApi = {
  list: () => api.get('/server-templates').then((r) => r.data as { icons: Record<string, { label: string; dataUrl: string }>; templates: ServerTemplate[] }),
  save: (template: ServerTemplate) => api.post('/server-templates', { template }).then((r) => r.data as { id: string }),
  update: (id: string, template: ServerTemplate) => api.put(`/server-templates/${id}`, { template }).then((r) => r.data),
  remove: (id: string) => api.delete(`/server-templates/${id}`).then((r) => r.data),
  apply: (c: number, s: number, body: { templateId?: string; template?: ServerTemplate; options: ApplyOptions }) =>
    api.post(`${vs(c, s)}/apply`, body, { timeout: 600000 }).then((r) => r.data as ApplyResult),
  exportServer: (c: number, s: number, name: string, save: boolean) =>
    api.post(`${vs(c, s)}/export`, { name, save }, { timeout: 180000 }).then((r) => r.data as ServerTemplate),
  setIcon: (c: number, s: number, body: { target: 'servergroup' | 'channelgroup' | 'channel' | 'server'; id: number; icon?: string; color?: string; png?: string }) =>
    api.post(`${vs(c, s)}/icon`, body, { timeout: 60000 }).then((r) => r.data),
};
