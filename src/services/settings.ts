import type { DatabaseSync } from 'node:sqlite';

export interface SiteSettings {
  site_name: string;
  site_tagline: string;
  applications_open: boolean;
  registration_open: boolean;
  public_contact: string;
}

const DEFAULTS: Record<string, string> = {
  site_name: 'TOP CLOUD',
  site_tagline: 'STAFF RECRUITMENT PORTAL',
  applications_open: '1',
  registration_open: '1',
  public_contact: 'Discord: tanveer5637',
};

export function getSettings(db: DatabaseSync): SiteSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    site_name: map.site_name ?? DEFAULTS.site_name,
    site_tagline: map.site_tagline ?? DEFAULTS.site_tagline,
    applications_open: map.applications_open !== '0',
    registration_open: map.registration_open !== '0',
    public_contact: map.public_contact ?? DEFAULTS.public_contact,
  };
}

export function updateSettings(db: DatabaseSync, patch: Partial<SiteSettings>): void {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const now = new Date().toISOString();
  const entries: [string, string][] = [
    ['site_name', patch.site_name ?? getSettings(db).site_name],
    ['site_tagline', patch.site_tagline ?? getSettings(db).site_tagline],
    ['applications_open', patch.applications_open === undefined ? String(getSettings(db).applications_open) : patch.applications_open ? '1' : '0'],
    ['registration_open', patch.registration_open === undefined ? String(getSettings(db).registration_open) : patch.registration_open ? '1' : '0'],
    ['public_contact', patch.public_contact ?? getSettings(db).public_contact],
  ];
  for (const [k, v] of entries) upsert.run(k, v, now);
}
