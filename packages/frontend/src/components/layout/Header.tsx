import { LogOut, User, Pause, Play, SkipForward } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { ServerSelector } from './ServerSelector';
import { useAuthStore } from '@/stores/auth.store';
import { useLogout } from '@/hooks/use-auth';
import { useMusicBots, usePausePlayback, useResumePlayback, useSkipTrack } from '@/hooks/use-music-bots';
import { SourceIcon } from '@/components/music/SourceIcon';

/** Compact "now playing" control for the first active music bot – visible on every page. */
function MiniPlayer() {
  const { data } = useMusicBots();
  const pause = usePausePlayback();
  const resume = useResumePlayback();
  const skip = useSkipTrack();
  const bots = Array.isArray(data) ? data : [];
  const bot = bots.find((b: any) => b.status === 'playing') ?? bots.find((b: any) => b.status === 'paused' && b.nowPlaying);
  if (!bot?.nowPlaying) return null;
  const np = bot.nowPlaying;
  const playing = bot.status === 'playing';

  return (
    <div className="hidden md:flex items-center gap-2 rounded-full border border-border bg-card/80 py-1 pl-1 pr-1.5 shadow-sm">
      <Link to="/music-bots" className="flex min-w-0 items-center gap-2.5 pr-1" title={`${bot.name}: ${np.title}`}>
        <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-muted">
          {np.thumbnail
            ? <img src={np.thumbnail} alt="" className={`h-full w-full object-cover ${playing ? 'spin-slow' : ''}`} referrerPolicy="no-referrer" />
            : <div className={`vinyl h-full w-full ${playing ? 'spin-slow' : ''}`} />}
        </div>
        <div className="min-w-0 max-w-[220px] leading-tight">
          <p className="truncate text-xs font-medium">{np.title}</p>
          <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
            <SourceIcon source={np.source} className="h-2.5 w-2.5" />
            {np.artist || bot.name}
          </p>
        </div>
        <span className={`eq ${playing ? '' : 'paused'}`}><span /><span /><span /><span /></span>
      </Link>
      <Button
        variant="ghost" size="icon" className="h-7 w-7 rounded-full"
        onClick={() => (playing ? pause.mutate(bot.id) : resume.mutate(bot.id))}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={() => skip.mutate(bot.id)} aria-label="Skip">
        <SkipForward className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function Header() {
  const { user } = useAuthStore();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const logout = useLogout();

  return (
    <header className="surface-glass sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-border px-5">
      <ServerSelector />

      <div className="flex items-center gap-2">
        {isAdmin && <MiniPlayer />}
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9 gap-2 rounded-full pl-1 pr-3">
              <div className="grid h-7 w-7 place-items-center rounded-full bg-primary/15 text-primary">
                {user?.displayName?.[0]?.toUpperCase() ?? <User className="h-3.5 w-3.5" />}
              </div>
              <span className="text-xs font-medium">{user?.displayName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{user?.displayName}</p>
              <p className="text-xs capitalize text-muted-foreground">{user?.role}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
