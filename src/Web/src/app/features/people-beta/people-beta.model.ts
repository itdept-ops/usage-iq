import { PersonDto } from '../../core/models';

/** Live presence state for the dot + label. */
export type Presence = 'online' | 'away' | 'offline';

/** A teammate not seen for >60s (their presence stamps every ~20s) is treated as AWAY. Mirrors the live page. */
export const AWAY_MS = 60_000;

/**
 * A person enriched with the derived bits the Circle row template needs — initials for the avatar
 * fallback, a stable accent index for the colored avatar ring, and a resolved presence state. Built
 * fresh on each clock tick so the relative "active …" labels + away nuance stay live between polls.
 */
export interface PersonVm extends PersonDto {
  /** Two-letter initials for the avatar fallback (name only — no email is ever on the wire). */
  initials: string;
  /** Resolved presence at the current tick: online / away (online but stale) / offline. */
  presence: Presence;
  /** A stable 0..5 hue index (off the AppUser id) so each avatar fallback gets a consistent color. */
  hue: number;
}

/** Two-letter initials for the avatar fallback (name only — never an email). */
export function initialsOf(name: string): string {
  const parts = (name || '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

/** Resolve a person's presence at a given clock tick (online → away when their lastSeen is stale). */
export function presenceOf(p: PersonDto, nowMs: number): Presence {
  if (!p.online) return 'offline';
  if (p.lastSeenUtc && nowMs - new Date(p.lastSeenUtc).getTime() >= AWAY_MS) return 'away';
  return 'online';
}

/** Project a wire PersonDto into the row view-model at the current tick. */
export function toVm(p: PersonDto, nowMs: number): PersonVm {
  return {
    ...p,
    initials: initialsOf(p.name),
    presence: presenceOf(p, nowMs),
    // 6 stable accent buckets keyed off the dedup id (self always rides the page accent in the row).
    hue: ((p.userId % 6) + 6) % 6,
  };
}

/** A human label for a household role chip ("Owner"/"Adult"/"Child"); falls back to the raw value. */
export function roleLabel(role: string | null): string {
  if (!role) return '';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Sort comparator for the "Everyone" group: self first, then online, then away, then by name. */
export function rosterSort(a: PersonVm, b: PersonVm): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  const rank = (p: PersonVm) => (p.presence === 'online' ? 0 : p.presence === 'away' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
}

/** Strict A–Z comparator (self still floats to the top so "you" stays anchored), then by name. */
export function alphaSort(a: PersonVm, b: PersonVm): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Whether a person's DisplayName contains the (already-lowercased) query — case-insensitive substring. */
export function matchesQuery(p: PersonVm, qLower: string): boolean {
  return !qLower || p.name.toLowerCase().includes(qLower);
}
