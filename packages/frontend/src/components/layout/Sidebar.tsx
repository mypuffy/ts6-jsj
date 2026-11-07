import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Server, Hash, Users, Shield, ShieldCheck,
  Lock, Ban, KeyRound, FolderOpen, MessageSquareWarning, Mail,
  ScrollText, Settings, Workflow, Cpu, PanelLeftClose, PanelLeftOpen, Disc3, History,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMusicBots } from '@/hooks/use-music-bots';

interface NavItem {
  to: string;
  icon: React.ElementType;
  label: string;
  adminOnly?: boolean;
  badge?: 'music';
}

const navSections: { label: string; adminOnly?: boolean; items: NavItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/music-bots', icon: Disc3, label: 'Music', adminOnly: true, badge: 'music' },
      { to: '/bots', icon: Workflow, label: 'Automations', adminOnly: true },
    ],
  },
  {
    label: 'Server',
    items: [
      { to: '/servers', icon: Server, label: 'Virtual Servers', adminOnly: true },
      { to: '/channels', icon: Hash, label: 'Channels' },
      { to: '/clients', icon: Users, label: 'Clients' },
      { to: '/server-groups', icon: Shield, label: 'Server Groups', adminOnly: true },
      { to: '/channel-groups', icon: ShieldCheck, label: 'Channel Groups', adminOnly: true },
      { to: '/permissions', icon: Lock, label: 'Permissions', adminOnly: true },
    ],
  },
  {
    label: 'Moderation',
    adminOnly: true,
    items: [
      { to: '/bans', icon: Ban, label: 'Bans', adminOnly: true },
      { to: '/tokens', icon: KeyRound, label: 'Tokens', adminOnly: true },
      { to: '/complaints', icon: MessageSquareWarning, label: 'Complaints', adminOnly: true },
      { to: '/messages', icon: Mail, label: 'Messages', adminOnly: true },
    ],
  },
  {
    label: 'System',
    adminOnly: true,
    items: [
      { to: '/files', icon: FolderOpen, label: 'Files', adminOnly: true },
      { to: '/logs', icon: ScrollText, label: 'Server Logs', adminOnly: true },
      { to: '/instance', icon: Cpu, label: 'Instance', adminOnly: true },
      { to: '/music-requests', icon: History, label: 'Request History', adminOnly: true },
    ],
  },
];

function LogoMark({ className }: { className?: string }) {
  return (
    <div className={cn('relative grid h-8 w-8 place-items-center rounded-lg bg-foreground/[0.06] ring-1 ring-inset ring-foreground/10', className)}>
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-primary" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
        <path d="M5 15V9M9.5 19V5M14.5 17V7M19 13v-2" />
      </svg>
    </div>
  );
}

function MusicBadge() {
  const { data } = useMusicBots();
  const playing = (Array.isArray(data) ? data : []).filter((b: any) => b.status === 'playing').length;
  if (!playing) return null;
  return (
    <span className="ml-auto flex items-center gap-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
      <span className="eq !h-2.5"><span /><span /><span /></span>
      {playing}
    </span>
  );
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const location = useLocation();

  const renderLink = (item: NavItem) => {
    const isActive = location.pathname === item.to || location.pathname.startsWith(item.to + '/');
    const link = (
      <NavLink
        key={item.to}
        to={item.to}
        className={cn(
          'group relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors duration-150',
          sidebarCollapsed && 'justify-center px-0',
          isActive
            ? 'bg-sidebar-accent text-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        )}
      >
        {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />}
        <item.icon className={cn('h-[18px] w-[18px] shrink-0 transition-colors', isActive ? 'text-primary' : 'text-sidebar-foreground/70 group-hover:text-foreground')} />
        {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
        {!sidebarCollapsed && item.badge === 'music' && isAdmin && <MusicBadge />}
      </NavLink>
    );
    if (!sidebarCollapsed) return link;
    return (
      <Tooltip key={item.to}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" className="font-medium">{item.label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'relative flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-in-out',
          sidebarCollapsed ? 'w-[68px]' : 'w-60',
        )}
      >
        {/* Brand */}
        <div className={cn('flex h-16 items-center gap-3 px-4', sidebarCollapsed && 'justify-center px-0')}>
          <LogoMark />
          {!sidebarCollapsed && (
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight text-foreground">TS6 Control</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/60">TeamSpeak · Music</p>
            </div>
          )}
        </div>

        <ScrollArea className="flex-1">
          <nav className="space-y-5 px-3 pb-4 pt-1">
            {navSections
              .filter((section) => !section.adminOnly || isAdmin)
              .map((section) => {
                const visible = section.items.filter((item) => !item.adminOnly || isAdmin);
                if (visible.length === 0) return null;
                return (
                  <div key={section.label} className="space-y-0.5">
                    {!sidebarCollapsed ? (
                      <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/45">
                        {section.label}
                      </p>
                    ) : (
                      <div className="mx-auto mb-1 h-px w-6 bg-sidebar-border" />
                    )}
                    {visible.map(renderLink)}
                  </div>
                );
              })}
          </nav>
        </ScrollArea>

        <div className="space-y-0.5 border-t border-sidebar-border p-3">
          {renderLink({ to: '/settings', icon: Settings, label: 'Settings' })}
          <button
            onClick={toggleSidebar}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground',
              sidebarCollapsed && 'justify-center px-0',
            )}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
            {!sidebarCollapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
