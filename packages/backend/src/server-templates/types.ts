/**
 * A complete TeamSpeak server layout: groups (with icons + permission presets),
 * channel tree (spacers, codecs, talk/join power, icons) and optional server settings.
 * Templates are plain JSON so they can be exported, edited and re-imported.
 */

export type GroupPreset =
  | 'admin'       // full rights (copy of "Server Admin")
  | 'moderator'   // kick / ban / move / poke, protected against normal users
  | 'support'     // move + poke + talk power, no bans
  | 'vip'         // join power + talk power, small protection
  | 'member'      // normal user (copy of "Normal")
  | 'dj'          // music / talk power, ignore antiflood
  | 'streamer'    // high talk power, priority speaker
  | 'bot'         // talk power, antiflood immune, hard to kick
  | 'custom';     // copy of "Normal" + only extraPerms

export type ChannelGroupPreset = 'channel_admin' | 'channel_operator' | 'channel_guest';

export interface TemplateServerGroup {
  /** Reference used by channels (joinGroup) and tokens */
  key: string;
  name: string;
  preset: GroupPreset;
  /** Built-in icon key (see icons.ts) */
  icon?: string;
  /** Override the icon colour, e.g. "#ff0000" */
  iconColor?: string;
  /** Lower = shown first */
  sortId?: number;
  /** 0 = hidden, 1 = before name, 2 = after name */
  showName?: 0 | 1 | 2;
  /** Extra / overriding permissions, permsid → value */
  extraPerms?: Record<string, number>;
  /** Create a privilege key (token) for this group after applying */
  createToken?: boolean;
}

export interface TemplateChannelGroup {
  key: string;
  name: string;
  preset: ChannelGroupPreset;
  icon?: string;
  iconColor?: string;
  sortId?: number;
  extraPerms?: Record<string, number>;
}

export interface TemplateChannel {
  /** Use "[cspacer]Text", "[lspacer]Text", "[rspacer]Text" or "[*spacer]═" for spacers – numbering is added automatically */
  name: string;
  topic?: string;
  description?: string;
  /** default: permanent */
  semiPermanent?: boolean;
  /** -1 / undefined = unlimited */
  maxClients?: number;
  password?: string;
  /** 4 = Opus Voice, 5 = Opus Music */
  codec?: 4 | 5;
  /** 0–10 */
  quality?: number;
  /** Clients land here after connecting (exactly one channel should have it) */
  isDefault?: boolean;
  /** Moderated channel: clients need this talk power to speak */
  neededTalkPower?: number;
  /** Required join power (i_channel_needed_join_power) */
  neededJoinPower?: number;
  /** Required subscribe power */
  neededSubscribePower?: number;
  /** Built-in icon key */
  icon?: string;
  iconColor?: string;
  children?: TemplateChannel[];
}

export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  category: 'gaming' | 'music' | 'esport' | 'community' | 'minimal' | 'custom';
  /** UI accent colour */
  accent?: string;
  server?: {
    name?: string;
    welcomeMessage?: string;
    hostMessage?: string;
    /** 0 none, 1 log, 2 modal, 3 modal + quit */
    hostMessageMode?: 0 | 1 | 2 | 3;
    maxClients?: number;
  };
  serverGroups: TemplateServerGroup[];
  channelGroups?: TemplateChannelGroup[];
  channels: TemplateChannel[];
}

export interface ApplyOptions {
  /** Delete all existing channels (clients are moved to the new default channel) */
  wipeChannels?: boolean;
  /** Delete existing non-default server groups whose name is NOT in the template */
  wipeGroups?: boolean;
  /** Apply server name / welcome message */
  applyServerSettings?: boolean;
  /** Upload icons and set them on groups/channels */
  icons?: boolean;
  /** Create privilege keys for groups with createToken */
  tokens?: boolean;
  /** Only compute the plan – change nothing */
  dryRun?: boolean;
}

export interface ApplyLogEntry {
  level: 'info' | 'ok' | 'warn' | 'error';
  message: string;
}

export interface ApplyResult {
  success: boolean;
  log: ApplyLogEntry[];
  created: { serverGroups: number; channelGroups: number; channels: number; icons: number };
  tokens: Array<{ group: string; token: string }>;
}
