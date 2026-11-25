import { useEffect, useState } from 'react';
import { api } from './api';
import type { GuildMeta } from './types';

let cache: Promise<GuildMeta> | null = null;

/** Discord roles/channels for pickers. Cached for the page session; call refresh() after bot changes. */
export function useGuildMeta(): { meta: GuildMeta; refresh: () => void } {
  const [meta, setMeta] = useState<GuildMeta>({ guildName: '', roles: [], channels: [] });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!cache) cache = api.guildMeta().catch(() => ({ guildName: '', roles: [], channels: [] }));
    cache.then(setMeta);
  }, [n]);
  return { meta, refresh: () => { cache = null; setN((x) => x + 1); } };
}
