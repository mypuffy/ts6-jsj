import { FileAudio, Link2, Radio, Youtube } from 'lucide-react';
import { cn } from '@/lib/utils';

/** SoundCloud cloud glyph (lucide has none) */
export function SoundCloudIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M11.2 8.2c.4-.2.9-.3 1.4-.3 2.3 0 4.2 1.7 4.5 4 .3-.1.6-.1.9-.1 1.7 0 3 1.4 3 3.1S19.7 18 18 18h-6.8a.5.5 0 0 1-.5-.5V8.7c0-.2.2-.4.5-.5Z" />
      <rect x="8.6" y="9.4" width="1.2" height="8.6" rx=".6" />
      <rect x="6.4" y="10.6" width="1.2" height="7.4" rx=".6" />
      <rect x="4.2" y="12" width="1.2" height="6" rx=".6" />
      <rect x="2" y="13.4" width="1.2" height="4.4" rx=".6" />
    </svg>
  );
}

export const SOURCE_META: Record<string, { label: string; className: string }> = {
  youtube: { label: 'YouTube', className: 'text-red-500' },
  soundcloud: { label: 'SoundCloud', className: 'text-orange-500' },
  radio: { label: 'Radio', className: 'text-sky-400' },
  local: { label: 'Library', className: 'text-emerald-400' },
  url: { label: 'Link', className: 'text-muted-foreground' },
};

export function SourceIcon({ source, className, colored = true }: { source?: string; className?: string; colored?: boolean }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', colored && SOURCE_META[source || 'url']?.className, className);
  switch (source) {
    case 'youtube': return <Youtube className={cls} />;
    case 'soundcloud': return <SoundCloudIcon className={cls} />;
    case 'radio': return <Radio className={cls} />;
    case 'local': return <FileAudio className={cls} />;
    default: return <Link2 className={cls} />;
  }
}
