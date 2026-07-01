import { FleetMachine } from '../../core/models';

/**
 * BETA FLEET — small, pure view-model helpers shared by the page + its subcomponents. No state, no
 * Angular: just formatting + classification over the EXISTING `FleetMachine`/`FleetUser` DTOs the
 * `/api/fleet` endpoint already serves. The server owns all aggregation; these only shape labels.
 */

/** The synthetic file-sync bucket is named "local" server-side — surface it as such, not a real host. */
export function isLocalName(name: string): boolean {
  return name === 'local';
}

/**
 * Online heuristic for the live "pulse" dot: a machine that reported within the last ONLINE_WINDOW_MS
 * is treated as online (a soft, presentation-only signal — the server doesn't track a session). Mirrors
 * a 10-minute reporter cadence with headroom.
 */
export const ONLINE_WINDOW_MS = 12 * 60 * 1000;

export function isOnline(lastSeenUtc: string | null, nowMs: number = Date.now()): boolean {
  if (!lastSeenUtc) return false;
  const t = new Date(lastSeenUtc).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t <= ONLINE_WINDOW_MS;
}

/** Normalize the raw reporter `agent` kind into a display label ("Desktop" | "Console" | title-cased | ""). */
export function agentLabel(agent: string | null): string {
  const a = (agent ?? '').trim().toLowerCase();
  if (a === 'desktop') return 'Desktop';
  if (a === 'console') return 'Console';
  if (!a) return '';
  return agent!.charAt(0).toUpperCase() + agent!.slice(1);
}

/** Material glyph for an agent kind (desktop tray vs CLI vs generic device). */
export function agentIcon(agent: string | null): string {
  const a = agentLabel(agent);
  if (a === 'Desktop') return 'desktop_windows';
  if (a === 'Console') return 'terminal';
  return 'dns';
}

/** A "City, Region, Country" label from a machine's resolved place (drops blanks); "" when none. */
export function locationLabel(m: FleetMachine): string {
  return [m.city, m.region, m.country].filter((p) => !!p && p!.trim().length).join(', ');
}

/** "Manufacturer Model" label (drops blanks); "" when neither is reported. */
export function systemLabel(m: FleetMachine): string {
  return [m.manufacturer, m.model].filter((p) => !!p && p!.trim().length).join(' ');
}

/** True when a machine has finite coordinates to plot/link. */
export function hasCoords(m: FleetMachine): boolean {
  return m.lat != null && m.lng != null && Number.isFinite(m.lat) && Number.isFinite(m.lng);
}

/** An OpenStreetMap link for a machine's coordinates (precise agent fix or coarse IP-geo). */
export function mapUrl(m: FleetMachine): string {
  return `https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=14/${m.lat}/${m.lng}`;
}

/** Geo-source badge text: "GPS" for a precise agent fix, "IP" for coarse IP-geo, else "". */
export function geoSourceLabel(source: string | null): string {
  const s = (source ?? '').trim().toLowerCase();
  if (s === 'agent') return 'GPS';
  if (s === 'ip-api') return 'IP';
  return '';
}

/** Human RAM size from megabytes (16384 → "16 GB"); null/0 → "". */
export function ramLabel(mb: number | null): string {
  if (mb == null || mb <= 0) return '';
  const gb = mb / 1024;
  return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
}

/** Human uptime from seconds ("3d 4h" / "5h 12m" / "8m"); null/0 → "". */
export function uptimeLabel(sec: number | null): string {
  if (sec == null || sec <= 0) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Which management mutation a fleet action sheet drives (mirrors the live FleetActionDialog). */
export type FleetAction = 'reassign' | 'delete' | 'revoke';

/** One combine/transfer target option in a reassign picker (a bucket other than the source). */
export interface FleetActionTarget {
  /** Machine dimension: the raw machine name. Empty for user targets. */
  rawValue: string;
  /** Friendly label shown in the picker. */
  label: string;
  /** User dimension: the target AppUser id (null = local/orphan bucket). */
  userId?: number | null;
}

/**
 * Input contract for the mobile FleetActionSheet — the bottom-sheet equivalent of the desktop
 * FleetActionDialog. For MACHINE `rawValue` is the raw machine name (already mapped from the "local"
 * display row to ""); for USER the client holds no email so `userId` carries the AppUser id (null for
 * the local/orphan bucket). `others` are the reassign picker's options (each with a `userId` for users).
 */
export interface FleetActionRequest {
  action: FleetAction;
  dimension: 'machine' | 'user';
  rawValue: string;
  userId?: number | null;
  label: string;
  records: number;
  others: FleetActionTarget[];
}

/** Compact-format a USD amount as "$1.2k" / "$1.2M" / "$12.34". Token/record counts use the CompactPipe. */
export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return `$${value.toFixed(2)}`;
}
