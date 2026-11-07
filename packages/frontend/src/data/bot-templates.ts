import { Clock, Users, Shield, Globe, Zap, MessageSquare, Moon, Timer, Megaphone, Award, FolderPlus, Eye, Webhook, Sparkles, Music, Radio, Volume1, BellRing, PartyPopper, ListMusic, ScrollText, Send, Hash, BookOpen } from 'lucide-react';

export interface TemplateConfigField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  placeholder?: string;
  defaultValue?: string;
  options?: { label: string; value: string }[];
  required?: boolean;
}

export interface BotTemplate {
  id: string;
  name: string;
  description: string;
  category: 'music' | 'info-channels' | 'moderation' | 'automation' | 'integration';
  icon: React.ElementType;
  configFields: TemplateConfigField[];
  flowDataFactory: (config: Record<string, string>) => { nodes: any[]; edges: any[] };
}

let _id = 0;
const nid = () => `tpl_${++_id}`;
const eid = () => `tpl_e${_id}`;

function resetIds() { _id = 0; }

// Helper to build a simple linear flow
function makeNode(id: string, type: string, label: string, config: Record<string, any>, x: number, y: number) {
  return { id, type, label, config, x, y };
}
function makeEdge(id: string, source: string, target: string, sourcePort = 'out', targetPort = 'in') {
  return { id, source, sourcePort, target, targetPort };
}

export const BOT_TEMPLATES: BotTemplate[] = [

  // ===== MUSIC =====
  {
    id: 'music-now-playing-channel',
    name: 'Now-Playing Channel',
    description: 'Shows the current track of a music bot as a channel name (e.g. "♪ Artist – Title"), updated every minute.',
    category: 'music',
    icon: Music,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'channelId', label: 'Channel ID to rename', type: 'number', placeholder: '42', required: true },
      { key: 'prefix', label: 'Prefix', type: 'text', defaultValue: '[cspacer]♪ ', placeholder: '[cspacer]♪ ' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      const prefix = cfg.prefix ?? '[cspacer]♪ ';
      const max = Math.max(8, 40 - prefix.length);
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Every Minute', { cron: '* * * * *' }, 60, 80),
          makeNode(n2, 'action_voiceNowPlaying', 'Read Now Playing', { botId: cfg.botId }, 300, 80),
          makeNode(n3, 'action_channelEdit', 'Update Channel', { channelId: cfg.channelId, channel_name: `${prefix}{{temp.music.display|trunc:${max}}}` }, 540, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },
  {
    id: 'music-request-command',
    name: 'Song Requests via Chat',
    description: 'Anyone can type !request <link or song> in server chat – works for YouTube, SoundCloud and Spotify links, even if they are not in the bot\'s channel.',
    category: 'music',
    icon: ListMusic,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'command', label: 'Command', type: 'text', defaultValue: 'request', placeholder: 'request' },
      { key: 'provider', label: 'Search on', type: 'select', defaultValue: 'soundcloud', options: [{ label: 'SoundCloud', value: 'soundcloud' }, { label: 'YouTube', value: 'youtube' }] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_command', `!${cfg.command || 'request'}`, { command: cfg.command || 'request' }, 60, 80),
          makeNode(n2, 'action_voicePlay', 'Queue Request', { botId: cfg.botId, url: '{{event.command_args}}', mode: 'queue', provider: cfg.provider || 'soundcloud' }, 300, 80),
          makeNode(n3, 'action_message', 'Confirm', { targetMode: 'client', message: '♪ Queued: [b]{{temp.music.title}}[/b]' }, 540, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },
  {
    id: 'music-scheduled-show',
    name: 'Scheduled Radio / DJ Set',
    description: 'Starts a radio station or a SoundCloud/YouTube set at a fixed time (e.g. Friday night) with autoplay, and stops it later.',
    category: 'music',
    icon: PartyPopper,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'url', label: 'Set / playlist link (or leave empty)', type: 'text', placeholder: 'https://soundcloud.com/artist/sets/friday' },
      { key: 'stationId', label: 'Radio station ID (alternative)', type: 'number', placeholder: '3' },
      { key: 'startCron', label: 'Start', type: 'select', defaultValue: '0 20 * * 5', options: [
        { label: 'Every day 20:00', value: '0 20 * * *' },
        { label: 'Fridays 20:00', value: '0 20 * * 5' },
        { label: 'Saturdays 21:00', value: '0 21 * * 6' },
        { label: 'Every day 08:00', value: '0 8 * * *' },
        { label: 'Every hour', value: '0 * * * *' },
      ] },
      { key: 'stopCron', label: 'Stop', type: 'select', defaultValue: '0 2 * * 6', options: [
        { label: 'Next day 02:00 (Sat)', value: '0 2 * * 6' },
        { label: 'Next day 02:00 (Sun)', value: '0 2 * * 0' },
        { label: 'Every day 23:59', value: '59 23 * * *' },
        { label: 'Never', value: '' },
      ] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid(), n5 = nid(), n6 = nid();
      const nodes: any[] = [
        makeNode(n1, 'trigger_cron', 'Show Start', { cron: cfg.startCron || '0 20 * * 5', timezone: 'Europe/Berlin' }, 60, 80),
        makeNode(n2, 'action_voiceAutoplay', 'Autoplay On', { botId: cfg.botId, enabled: 'on' }, 300, 80),
        makeNode(n3, 'action_voicePlay', 'Start Set', { botId: cfg.botId, url: cfg.url || '', stationId: cfg.stationId || '', mode: 'now' }, 540, 80),
        makeNode(n4, 'action_voiceMessage', 'Announce', { botId: cfg.botId, message: '[b]The show starts now![/b] ♪ {{temp.music.title}}' }, 780, 80),
      ];
      const edges = [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3), makeEdge(eid(), n3, n4)];
      if (cfg.stopCron) {
        nodes.push(
          makeNode(n5, 'trigger_cron', 'Show End', { cron: cfg.stopCron, timezone: 'Europe/Berlin' }, 60, 220),
          makeNode(n6, 'action_voicePauseResume', 'Pause', { botId: cfg.botId, action: 'pause' }, 300, 220),
        );
        edges.push(makeEdge(eid(), n5, n6));
      }
      return { nodes, edges };
    },
  },
  {
    id: 'music-night-volume',
    name: 'Night Volume',
    description: 'Lowers the music bot volume in the evening and raises it again in the morning.',
    category: 'music',
    icon: Volume1,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'nightVolume', label: 'Night volume (0-100)', type: 'number', defaultValue: '15', placeholder: '15' },
      { key: 'dayVolume', label: 'Day volume (0-100)', type: 'number', defaultValue: '40', placeholder: '40' },
      { key: 'nightHour', label: 'Night starts (hour)', type: 'number', defaultValue: '23', placeholder: '23' },
      { key: 'dayHour', label: 'Day starts (hour)', type: 'number', defaultValue: '9', placeholder: '9' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Night', { cron: `0 ${cfg.nightHour || 23} * * *`, timezone: 'Europe/Berlin' }, 60, 80),
          makeNode(n2, 'action_voiceVolume', 'Quiet', { botId: cfg.botId, volume: cfg.nightVolume || '15' }, 300, 80),
          makeNode(n3, 'trigger_cron', 'Morning', { cron: `0 ${cfg.dayHour || 9} * * *`, timezone: 'Europe/Berlin' }, 60, 200),
          makeNode(n4, 'action_voiceVolume', 'Normal', { botId: cfg.botId, volume: cfg.dayVolume || '40' }, 300, 200),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n3, n4)],
      };
    },
  },
  {
    id: 'music-follow-to-channel',
    name: 'Music Follows Me',
    description: 'Type !dj in a channel and the music bot moves there (great for events or temporary rooms).',
    category: 'music',
    icon: Radio,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'command', label: 'Command', type: 'text', defaultValue: 'dj', placeholder: 'dj' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_command', `!${cfg.command || 'dj'}`, { command: cfg.command || 'dj' }, 60, 80),
          makeNode(n2, 'action_webquery', 'Find Caller', { command: 'clientinfo clid={{event.clid}}', storeAs: 'caller' }, 300, 80),
          makeNode(n3, 'action_voiceJoinChannel', 'Bot Joins', { botId: cfg.botId, channelId: '{{temp.caller.cid}}' }, 540, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },
  {
    id: 'music-welcome-jingle',
    name: 'Channel Jingle',
    description: 'Plays a jingle or intro track next when someone joins the music channel.',
    category: 'music',
    icon: BellRing,
    configFields: [
      { key: 'botId', label: 'Music Bot ID', type: 'number', placeholder: '1', required: true },
      { key: 'channelId', label: 'Music channel ID', type: 'number', placeholder: '12', required: true },
      { key: 'songId', label: 'Library song ID (jingle)', type: 'number', placeholder: '7', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Moved', { eventName: 'notifyclientmoved' }, 60, 80),
          makeNode(n2, 'condition', 'Joined Music Channel?', { expression: `event.ctid == ${cfg.channelId}` }, 300, 80),
          makeNode(n3, 'action_voicePlay', 'Queue Jingle', { botId: cfg.botId, songId: cfg.songId, mode: 'next' }, 540, 40),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3, 'true', 'in')],
      };
    },
  },
  // ===== INFO CHANNELS =====
  {
    id: 'clock-channel',
    name: 'Clock Channel',
    description: 'Updates a channel name with the current time every minute.',
    category: 'info-channels',
    icon: Clock,
    configFields: [
      { key: 'channelId', label: 'Channel ID', type: 'number', placeholder: '42', required: true },
      { key: 'timezone', label: 'Timezone', type: 'select', defaultValue: 'Europe/Berlin', options: [
        { label: 'Europe/Berlin (CET/CEST)', value: 'Europe/Berlin' },
        { label: 'Europe/London (GMT/BST)', value: 'Europe/London' },
        { label: 'Europe/Paris (CET/CEST)', value: 'Europe/Paris' },
        { label: 'Europe/Moscow (MSK)', value: 'Europe/Moscow' },
        { label: 'America/New_York (EST/EDT)', value: 'America/New_York' },
        { label: 'America/Chicago (CST/CDT)', value: 'America/Chicago' },
        { label: 'America/Los_Angeles (PST/PDT)', value: 'America/Los_Angeles' },
        { label: 'Asia/Tokyo (JST)', value: 'Asia/Tokyo' },
        { label: 'UTC', value: 'UTC' },
      ] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Every Minute', { cron: '* * * * *', timezone: cfg.timezone || 'Europe/Berlin' }, 60, 80),
          makeNode(n2, 'action_channelEdit', 'Update Clock', { channelId: cfg.channelId, channel_name: '[cspacer]{{time.time}}' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'online-counter',
    name: 'Online Counter',
    description: 'Shows the current online client count in a channel name.',
    category: 'info-channels',
    icon: Users,
    configFields: [
      { key: 'channelId', label: 'Channel ID', type: 'number', placeholder: '43', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Every Minute', { cron: '* * * * *' }, 60, 80),
          makeNode(n2, 'action_webquery', 'Get Server Info', { command: 'serverinfo', storeAs: 'server' }, 300, 80),
          makeNode(n3, 'action_channelEdit', 'Update Counter', { channelId: cfg.channelId, channel_name: '[cspacer]Online: {{temp.server.virtualserver_clientsonline}}/{{temp.server.virtualserver_maxclients}}' }, 540, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },
  {
    id: 'server-stats',
    name: 'Server Stats',
    description: 'Displays uptime, online clients, and channel count in three info channels.',
    category: 'info-channels',
    icon: Eye,
    configFields: [
      { key: 'uptimeChannelId', label: 'Uptime Channel ID', type: 'number', placeholder: '44', required: true },
      { key: 'clientsChannelId', label: 'Clients Channel ID', type: 'number', placeholder: '45', required: true },
      { key: 'channelCountChannelId', label: 'Channel Count Channel ID', type: 'number', placeholder: '46', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid(), n5 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Every 5 Min', { cron: '*/5 * * * *' }, 60, 150),
          makeNode(n2, 'action_webquery', 'Get Server Info', { command: 'serverinfo', storeAs: 'server' }, 300, 150),
          makeNode(n3, 'action_channelEdit', 'Uptime', { channelId: cfg.uptimeChannelId, channel_name: '[cspacer]Uptime: {{temp.server.virtualserver_uptime|uptime}}' }, 540, 60),
          makeNode(n4, 'action_channelEdit', 'Clients', { channelId: cfg.clientsChannelId, channel_name: '[cspacer]Clients: {{temp.server.virtualserver_clientsonline}}/{{temp.server.virtualserver_maxclients}}' }, 540, 150),
          makeNode(n5, 'action_channelEdit', 'Channels', { channelId: cfg.channelCountChannelId, channel_name: '[cspacer]Channels: {{temp.server.virtualserver_channelsonline}}' }, 540, 240),
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3),
          makeEdge(eid(), n2, n4),
          makeEdge(eid(), n2, n5),
        ],
      };
    },
  },

  {
    id: 'animated-channel',
    name: 'Animated Channel Name',
    description: 'Animates a channel name with visual effects like scrolling marquee, typewriter, bounce, and more. Updates every 2-5 seconds.',
    category: 'info-channels',
    icon: Sparkles,
    configFields: [
      { key: 'channelId', label: 'Channel ID', type: 'number', placeholder: '42', required: true },
      { key: 'text', label: 'Display Text', type: 'text', placeholder: 'Welcome to MyServer', required: true },
      { key: 'style', label: 'Animation Style', type: 'select', defaultValue: 'scroll', options: [
        { label: 'Scroll Left (Marquee)', value: 'scroll' },
        { label: 'Typewriter', value: 'typewriter' },
        { label: 'Bounce', value: 'bounce' },
        { label: 'Blink', value: 'blink' },
        { label: 'Wave (Decorative)', value: 'wave' },
        { label: 'Alternate Case', value: 'alternateCase' },
      ] },
      { key: 'intervalSeconds', label: 'Speed', type: 'select', defaultValue: '3', options: [
        { label: 'Slow (5s)', value: '5' },
        { label: 'Medium (3s)', value: '3' },
        { label: 'Fast (2s)', value: '2' },
        { label: 'Very Fast (1s)', value: '1' },
        { label: 'Ultra (0.5s)', value: '0.5' },
        { label: 'Insane (0.25s)', value: '0.25' },
      ] },
      { key: 'prefix', label: 'Channel Name Prefix', type: 'text', placeholder: '[cspacer]', defaultValue: '[cspacer]' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid();
      return {
        nodes: [
          makeNode(n1, 'action_animatedChannel', 'Animated Channel', {
            channelId: cfg.channelId,
            text: cfg.text || 'Welcome to MyServer',
            style: cfg.style || 'scroll',
            intervalSeconds: cfg.intervalSeconds || '3',
            prefix: cfg.prefix || '[cspacer]',
          }, 200, 100),
        ],
        edges: [],
      };
    },
  },

  // ===== AUTOMATION =====
  {
    id: 'welcome-message',
    name: 'Welcome Message',
    description: 'Sends a welcome message or poke when a client joins the server.',
    category: 'automation',
    icon: MessageSquare,
    configFields: [
      { key: 'message', label: 'Welcome Message', type: 'text', placeholder: 'Welcome {{event.client_nickname}}!', required: true },
      { key: 'usePokeInstead', label: 'Delivery Method', type: 'select', defaultValue: 'message', options: [{ label: 'Private Message', value: 'message' }, { label: 'Poke', value: 'poke' }] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      const usePoke = cfg.usePokeInstead === 'poke';
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Is Human?', { expression: 'event.client_type == 0' }, 300, 80),
          usePoke
            ? makeNode(n3, 'action_poke', 'Welcome Poke', { message: cfg.message || 'Welcome!' }, 540, 40)
            : makeNode(n3, 'action_message', 'Welcome Msg', { targetMode: 'client', message: cfg.message || 'Welcome!' }, 540, 40),
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
        ],
      };
    },
  },
  {
    id: 'support-system',
    name: 'Support System',
    description: 'Notifies admins when a client joins the support channel.',
    category: 'automation',
    icon: Megaphone,
    configFields: [
      { key: 'supportChannelId', label: 'Support Channel ID', type: 'number', placeholder: '15', required: true },
      { key: 'adminGroupId', label: 'Admin Group ID', type: 'number', placeholder: '6', required: true },
      { key: 'message', label: 'Notification Message', type: 'text', placeholder: 'Support needed by {{event.client_nickname}}!' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Moved', { eventName: 'notifyclientmoved' }, 60, 80),
          makeNode(n2, 'condition', 'Joined Support?', { expression: `event.ctid == ${cfg.supportChannelId}` }, 300, 80),
          makeNode(n3, 'action_webquery', 'Get Client Info', { command: 'clientinfo clid={{event.clid}}', storeAs: 'client' }, 540, 40),
          makeNode(n4, 'action_pokeGroup', 'Notify Admins', { groupId: cfg.adminGroupId, message: cfg.message || 'Support needed by {{temp.client.client_nickname}}!' }, 780, 40),
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
          makeEdge(eid(), n3, n4),
        ],
      };
    },
  },
  {
    id: 'temp-channel-creator',
    name: 'Temp Channel Creator',
    description: 'Creates a temporary channel when a client joins a lobby channel, then moves them in. Channel is auto-deleted when empty.',
    category: 'automation',
    icon: FolderPlus,
    configFields: [
      { key: 'lobbyChannelId', label: 'Lobby Channel ID', type: 'number', placeholder: '20', required: true },
      { key: 'parentChannelId', label: 'Parent Channel ID', type: 'number', placeholder: '19', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid(), n5 = nid();
      const n6 = nid(), n7 = nid();
      return {
        nodes: [
          // Create channel when user joins lobby
          makeNode(n1, 'trigger_event', 'Client Moved', { eventName: 'notifyclientmoved' }, 60, 80),
          makeNode(n2, 'condition', 'Joined Lobby?', { expression: `event.ctid == ${cfg.lobbyChannelId}` }, 300, 80),
          makeNode(n3, 'action_webquery', 'Get Client Info', { command: 'clientinfo clid={{event.clid}}', storeAs: 'client' }, 540, 80),
          makeNode(n4, 'action_channelCreate', 'Create Channel', { channel_name: "{{temp.client.client_nickname}}'s Channel", cpid: cfg.parentChannelId, channel_flag_semi_permanent: '1' }, 780, 80),
          makeNode(n5, 'action_move', 'Move to Channel', { cid: '{{temp.lastCreatedChannelId}}' }, 1020, 80),
          // Cron cleanup: delete empty channels under parent every minute
          makeNode(n6, 'trigger_cron', 'Cleanup Timer', { cron: '* * * * *' }, 60, 220),
          makeNode(n7, 'action_tempChannelCleanup', 'Delete Empty Channels', { parentChannelId: cfg.parentChannelId, protectedChannelIds: cfg.lobbyChannelId }, 300, 220),
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
          makeEdge(eid(), n3, n4),
          makeEdge(eid(), n4, n5),
          makeEdge(eid(), n6, n7),
        ],
      };
    },
  },
  {
    id: 'auto-rank',
    name: 'Auto-Rank',
    description: 'Automatically assigns server groups based on cumulative online time.',
    category: 'automation',
    icon: Award,
    configFields: [
      { key: 'ranks', label: 'Ranks (JSON)', type: 'text', placeholder: '[{"hours":10,"groupId":"7"},{"hours":50,"groupId":"8"}]', required: true },
      { key: 'pollInterval', label: 'Check Interval', type: 'select', defaultValue: '*/5 * * * *', options: [{ label: 'Every 5 min', value: '*/5 * * * *' }, { label: 'Every 15 min', value: '*/15 * * * *' }, { label: 'Every hour', value: '0 * * * *' }] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Rank Timer', { cron: cfg.pollInterval || '*/5 * * * *' }, 60, 80),
          makeNode(n2, 'action_rankCheck', 'Check Ranks', { ranks: cfg.ranks || '[]' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'last-seen-tracker',
    name: 'Last-Seen Tracker',
    description: 'Records the last-seen timestamp when a client disconnects.',
    category: 'automation',
    icon: Clock,
    configFields: [],
    flowDataFactory: () => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Leave', { eventName: 'notifyclientleftview' }, 60, 80),
          makeNode(n2, 'variable', 'Store Timestamp', { operation: 'set', name: 'lastseen_{{event.client_database_id}}', value: '{{time.timestamp}}' }, 300, 80),
          makeNode(n3, 'log', 'Log Leave', { level: 'info', message: '{{event.client_nickname}} left (dbid={{event.client_database_id}})' }, 540, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },

  // ===== MODERATION =====
  {
    id: 'afk-mover',
    name: 'AFK Mover',
    description: 'Moves idle clients to an AFK channel after a configurable timeout.',
    category: 'moderation',
    icon: Moon,
    configFields: [
      { key: 'afkChannelId', label: 'AFK Channel ID', type: 'number', placeholder: '10', required: true },
      { key: 'idleThresholdSeconds', label: 'Idle Threshold (seconds)', type: 'number', placeholder: '300', required: true },
      { key: 'exemptGroupIds', label: 'Exempt Group IDs (comma-separated)', type: 'text', placeholder: '6,7' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'AFK Check', { cron: '* * * * *' }, 60, 80),
          makeNode(n2, 'action_afkMover', 'Move AFK', { afkChannelId: cfg.afkChannelId, idleThresholdSeconds: cfg.idleThresholdSeconds || '300', exemptGroupIds: cfg.exemptGroupIds || '' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'idle-kicker',
    name: 'Idle Kicker',
    description: 'Kicks clients that have been idle for too long.',
    category: 'moderation',
    icon: Timer,
    configFields: [
      { key: 'idleThresholdSeconds', label: 'Idle Threshold (seconds)', type: 'number', placeholder: '1800', required: true },
      { key: 'reason', label: 'Kick Reason', type: 'text', placeholder: 'Idle timeout' },
      { key: 'exemptGroupIds', label: 'Exempt Group IDs (comma-separated)', type: 'text', placeholder: '6,7' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Idle Check', { cron: '* * * * *' }, 60, 80),
          makeNode(n2, 'action_idleKicker', 'Kick Idle', { idleThresholdSeconds: cfg.idleThresholdSeconds || '1800', reason: cfg.reason || 'Idle timeout', exemptGroupIds: cfg.exemptGroupIds || '' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'bad-name-checker',
    name: 'Bad Name Checker',
    description: 'Kicks clients whose nickname contains forbidden words.',
    category: 'moderation',
    icon: Shield,
    configFields: [
      { key: 'badWords', label: 'Bad Words (comma-separated)', type: 'text', placeholder: 'admin,moderator,test', required: true },
      { key: 'reason', label: 'Kick Reason', type: 'text', placeholder: 'Forbidden nickname' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const words = (cfg.badWords || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
      // Build expression: contains(lower(event.client_nickname),'word1') or contains(...)
      const expr = words.length > 0
        ? words.map(w => `contains(lower(event.client_nickname),'${w}')`).join(' or ')
        : "contains(lower(event.client_nickname),'admin')";

      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Is Human?', { expression: 'event.client_type == 0' }, 300, 80),
          makeNode(n3, 'condition', 'Bad Name?', { expression: expr }, 540, 40),
          makeNode(n4, 'action_kick', 'Kick Bad Name', { reasonid: '5', reason: cfg.reason || 'Forbidden nickname' }, 780, 0),
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
          makeEdge(eid(), n3, n4, 'true', 'in'),
        ],
      };
    },
  },
  {
    id: 'group-protector',
    name: 'Group Protector',
    description: 'Kicks clients who have a protected group but lack the required authorization group.',
    category: 'moderation',
    icon: Shield,
    configFields: [
      { key: 'protectedGroupId', label: 'Protected Group ID', type: 'number', placeholder: '8', required: true },
      { key: 'allowedGroupId', label: 'Authorized Group ID', type: 'number', placeholder: '10', required: true },
      { key: 'action', label: 'Action', type: 'select', defaultValue: 'kick', options: [{ label: 'Kick', value: 'kick' }, { label: 'Remove Group', value: 'remove' }] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid();
      const actionNode = cfg.action === 'remove'
        ? makeNode(n4, 'action_groupRemove', 'Remove Group', { groupId: cfg.protectedGroupId }, 780, 0)
        : makeNode(n4, 'action_kick', 'Kick Intruder', { reasonid: '5', reason: 'Unauthorized group' }, 780, 0);

      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Has Protected?', { expression: `contains(event.client_servergroups,'${cfg.protectedGroupId}')` }, 300, 80),
          makeNode(n3, 'condition', 'Missing Auth?', { expression: `contains(event.client_servergroups,'${cfg.allowedGroupId}') == 0` }, 540, 40),
          actionNode,
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
          makeEdge(eid(), n3, n4, 'true', 'in'),
        ],
      };
    },
  },

  // ===== INTEGRATION =====
  {
    id: 'webhook-server-message',
    name: 'Webhook → Server Message',
    description: 'Receives a webhook POST and broadcasts the message to the TeamSpeak server. Great for monitoring alerts, CI/CD notifications, or Discord bridges.',
    category: 'integration',
    icon: Webhook,
    configFields: [
      { key: 'path', label: 'Webhook Path', type: 'text', placeholder: 'server-notify', required: true },
      { key: 'secret', label: 'Secret (optional)', type: 'text', placeholder: 'my-secret-key' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_webhook', 'Incoming Webhook', { path: cfg.path || 'server-notify', method: 'POST', secret: cfg.secret || '' }, 60, 80),
          makeNode(n2, 'action_message', 'Broadcast Message', { targetMode: '3', message: '[Webhook] {{event.webhook_body}}' }, 340, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'webhook-group-assign',
    name: 'Webhook → Assign Group',
    description: 'External system (e.g. website verification) sends a webhook with a client database ID to assign a server group. Use for website-to-TS3 user verification.',
    category: 'integration',
    icon: Webhook,
    configFields: [
      { key: 'path', label: 'Webhook Path', type: 'text', placeholder: 'verify-user', required: true },
      { key: 'groupId', label: 'Server Group ID to assign', type: 'text', placeholder: '42', required: true },
      { key: 'secret', label: 'Secret (optional)', type: 'text', placeholder: 'my-secret-key' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_webhook', 'Verification Webhook', { path: cfg.path || 'verify-user', method: 'POST', secret: cfg.secret || '' }, 60, 80),
          makeNode(n2, 'action_webquery', 'Add to Group', { command: 'servergroupaddclient', params: { sgid: cfg.groupId, cldbid: '{{event.webhook_body.cldbid}}' } }, 340, 80),
          makeNode(n3, 'log', 'Log Result', { level: 'info', message: 'Assigned group {{groupId}} to cldbid {{event.webhook_body.cldbid}}' }, 600, 80),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3)],
      };
    },
  },
  {
    id: 'webhook-channel-rename',
    name: 'Webhook → Update Channel',
    description: 'Receives a webhook and updates a channel name. Use for external status displays like game server status, stream status, or monitoring dashboards.',
    category: 'integration',
    icon: Webhook,
    configFields: [
      { key: 'path', label: 'Webhook Path', type: 'text', placeholder: 'update-status', required: true },
      { key: 'channelId', label: 'Channel ID to update', type: 'text', placeholder: '42', required: true },
      { key: 'nameTemplate', label: 'Channel Name Template', type: 'text', placeholder: '[STATUS] {{event.webhook_body.status}}', required: true },
      { key: 'secret', label: 'Secret (optional)', type: 'text', placeholder: 'my-secret-key' },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_webhook', 'Status Webhook', { path: cfg.path || 'update-status', method: 'POST', secret: cfg.secret || '' }, 60, 80),
          makeNode(n2, 'action_channelEdit', 'Update Channel', { channelId: cfg.channelId, params: { channel_name: cfg.nameTemplate || '[STATUS] {{event.webhook_body.status}}' } }, 340, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'anti-vpn',
    name: 'Anti-VPN',
    description: 'Checks connecting clients against a VPN detection API and kicks/bans VPN users.',
    category: 'integration',
    icon: Globe,
    configFields: [
      { key: 'apiUrl', label: 'API URL (use {{ip}} placeholder)', type: 'text', placeholder: 'https://vpnapi.io/api/{{ip}}?key=YOUR_KEY', required: true },
      { key: 'action', label: 'Action for VPN', type: 'select', defaultValue: 'kick', options: [{ label: 'Kick', value: 'kick' }, { label: 'Ban (1h)', value: 'ban' }] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid(), n5 = nid();
      const url = (cfg.apiUrl || '').replace('{{ip}}', '{{event.connection_client_ip}}');
      const actionNode = cfg.action === 'ban'
        ? makeNode(n5, 'action_ban', 'Ban VPN', { time: 3600, reason: 'VPN detected' }, 780, 0)
        : makeNode(n5, 'action_kick', 'Kick VPN', { reasonid: '5', reason: 'VPN detected' }, 780, 0);

      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Is Human?', { expression: 'event.client_type == 0' }, 300, 80),
          makeNode(n3, 'action_httpRequest', 'Check VPN API', { url, method: 'GET', storeAs: 'vpn' }, 540, 40),
          makeNode(n4, 'condition', 'Is VPN?', { expression: "temp.vpn.security.vpn == 1 or temp.vpn.security.proxy == 1" }, 540, 120),
          actionNode,
        ],
        edges: [
          makeEdge(eid(), n1, n2),
          makeEdge(eid(), n2, n3, 'true', 'in'),
          makeEdge(eid(), n3, n4),
          makeEdge(eid(), n4, n5, 'true', 'in'),
        ],
      };
    },
  },

  // ===== MORE MODERATION / AUTOMATION / INTEGRATION =====
  {
    id: 'guest-rules-poke',
    name: 'Rules for Guests',
    description: 'Pokes every guest (default group) with your server rules when they connect.',
    category: 'moderation',
    icon: BookOpen,
    configFields: [
      { key: 'guestGroupId', label: 'Guest group ID', type: 'number', defaultValue: '8', placeholder: '8', required: true },
      { key: 'message', label: 'Rules message', type: 'text', placeholder: 'Welcome! Please read the rules in #rules.', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Is Guest?', { expression: `event.client_type == 0 and event.client_servergroups == "${cfg.guestGroupId || '8'}"` }, 300, 80),
          makeNode(n3, 'action_poke', 'Poke Rules', { message: cfg.message || 'Please read the rules.' }, 540, 40),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3, 'true', 'in')],
      };
    },
  },
  {
    id: 'scheduled-announcement',
    name: 'Scheduled Announcement',
    description: 'Sends a server-wide message on a schedule (events, restarts, Discord link…).',
    category: 'automation',
    icon: Megaphone,
    configFields: [
      { key: 'message', label: 'Message', type: 'text', placeholder: '[b]Party tonight at 20:00![/b]', required: true },
      { key: 'cron', label: 'When', type: 'select', defaultValue: '0 */2 * * *', options: [
        { label: 'Every 2 hours', value: '0 */2 * * *' },
        { label: 'Every hour', value: '0 * * * *' },
        { label: 'Every day 18:00', value: '0 18 * * *' },
        { label: 'Fridays 19:30', value: '30 19 * * 5' },
      ] },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_cron', 'Schedule', { cron: cfg.cron || '0 */2 * * *', timezone: 'Europe/Berlin' }, 60, 80),
          makeNode(n2, 'action_message', 'Server Message', { targetMode: 'server', message: cfg.message || '' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'help-command',
    name: '!help Command',
    description: 'Replies to !help with a custom info text (commands, links, rules).',
    category: 'automation',
    icon: Hash,
    configFields: [
      { key: 'text', label: 'Reply text', type: 'text', placeholder: 'Music: !play <link> · Requests: !request · Website: example.com', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_command', '!help', { command: 'help' }, 60, 80),
          makeNode(n2, 'action_message', 'Reply', { targetMode: 'client', message: cfg.text || '' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
  {
    id: 'discord-join-log',
    name: 'Discord Join/Leave Log',
    description: 'Posts joins and leaves into a Discord channel via webhook.',
    category: 'integration',
    icon: Send,
    configFields: [
      { key: 'webhookUrl', label: 'Discord webhook URL', type: 'text', placeholder: 'https://discord.com/api/webhooks/…', required: true },
    ],
    flowDataFactory: (cfg) => {
      resetIds();
      const n1 = nid(), n2 = nid(), n3 = nid(), n4 = nid(), n5 = nid();
      const headers = { 'Content-Type': 'application/json' };
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'condition', 'Is Human?', { expression: 'event.client_type == 0' }, 300, 80),
          makeNode(n3, 'action_httpRequest', 'Post Join', { url: cfg.webhookUrl, method: 'POST', headers, body: '{"content":"\ud83d\udfe2 **{{event.client_nickname|json}}** joined TeamSpeak"}' }, 540, 40),
          makeNode(n4, 'trigger_event', 'Client Leave', { eventName: 'notifyclientleftview' }, 60, 220),
          makeNode(n5, 'action_httpRequest', 'Post Leave', { url: cfg.webhookUrl, method: 'POST', headers, body: '{"content":"\ud83d\udd34 client {{event.clid}} left ({{event.reasonmsg|json}})"}' }, 300, 220),
        ],
        edges: [makeEdge(eid(), n1, n2), makeEdge(eid(), n2, n3, 'true', 'in'), makeEdge(eid(), n4, n5)],
      };
    },
  },
  {
    id: 'join-log',
    name: 'Join Log',
    description: 'Logs every connect with nickname, IP country and client version for later review.',
    category: 'moderation',
    icon: ScrollText,
    configFields: [],
    flowDataFactory: () => {
      resetIds();
      const n1 = nid(), n2 = nid();
      return {
        nodes: [
          makeNode(n1, 'trigger_event', 'Client Enter', { eventName: 'notifycliententerview' }, 60, 80),
          makeNode(n2, 'log', 'Log Join', { level: 'info', message: '{{event.client_nickname}} joined · country={{event.client_country}} · version={{event.client_version}} · dbid={{event.client_database_id}}' }, 300, 80),
        ],
        edges: [makeEdge(eid(), n1, n2)],
      };
    },
  },
];

export const TEMPLATE_CATEGORIES = [
  { id: 'music', label: 'Music', description: 'Now-playing channels, song requests, scheduled shows' },
  { id: 'info-channels', label: 'Info Channels', description: 'Dynamic channel names with live data' },
  { id: 'moderation', label: 'Moderation', description: 'Automated moderation and protection' },
  { id: 'automation', label: 'Automation', description: 'Welcome messages, temp channels, ranking' },
  { id: 'integration', label: 'Integration', description: 'External APIs and webhooks' },
] as const;
