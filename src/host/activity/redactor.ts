/**
 * The Redactor — the privacy boundary of the plugin.
 *
 * Everything the browser can see is produced here from an explicit allow-list:
 * a tool family, a truncated basename, a status, timings. Paths are reduced to
 * their last segment; secret-bearing files are masked entirely (spec §9).
 */
import { SENSITIVE_TARGET_LABEL } from '../../shared/task-context-types';

/** Longest display target we will forward. */
const MAX_TARGET = 40;

/**
 * Filenames whose very name is a secret signal. Even the basename is withheld:
 * `.env.production` tells an observer what to look for.
 */
const SENSITIVE_EXACT = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.npmrc',
  '.netrc',
  '.pgpass',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'credentials',
  'credentials.json',
  'secrets',
  'secrets.json',
  'kubeconfig',
  '.git-credentials',
  '.htpasswd',
]);

/** Extensions that only ever hold key material or certificates. */
const SECRET_EXTENSIONS = new Set([
  'key',
  'keys',
  'pem',
  'p12',
  'pfx',
  'crt',
  'cer',
  'keystore',
  'jks',
  'p8',
  'secret',
  'secrets',
]);

/** Words that mark a file as credential-bearing wherever they appear. */
const STRONG_WORDS = /(credential|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key)/i;

/** True when a basename must never be shown. */
export function isSensitiveName(basename: string): boolean {
  const name = basename.trim().toLowerCase();
  if (name === '') return false;
  if (SENSITIVE_EXACT.has(name)) return true;
  if (name.startsWith('.env')) return true;
  if (STRONG_WORDS.test(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && SECRET_EXTENSIONS.has(name.slice(dot + 1))) return true;
  return false;
}

export interface RedactedTarget {
  /** Safe, shortened basename — or the sensitive-file placeholder. */
  value: string;
  /** True when the real name was withheld. */
  redacted: boolean;
}

/**
 * Reduce a path-like string to a display-only target.
 *
 * Directories, user names, home prefixes and absolute roots are dropped, so a
 * leaked target can never identify where the user keeps their files. A
 * secret-bearing name is replaced by a fixed placeholder.
 */
export function redactPath(value: string): RedactedTarget | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '') return undefined;

  const segments = cleaned
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (segments.length === 0) return undefined;
  const last = segments[segments.length - 1] ?? '';
  // A bare drive letter or separator is not a filename.
  if (/^[a-zA-Z]:$/.test(last)) return undefined;
  // Drop a query/fragment, then only the characters no filesystem allows.
  const withoutQuery = last
    .replace(/[?#].*$/, '')
    .replace(/[<>"|:]/g, '')
    .trim();
  if (withoutQuery === '' || withoutQuery === '~') return undefined;

  if (isSensitiveName(withoutQuery)) return { value: SENSITIVE_TARGET_LABEL, redacted: true };
  return {
    value: withoutQuery.length > MAX_TARGET ? `${withoutQuery.slice(0, MAX_TARGET - 1)}…` : withoutQuery,
    redacted: false,
  };
}

/** Backwards-compatible string form: `undefined` when nothing safe remains. */
export function sanitizeBasename(value: string): string | undefined {
  const redacted = redactPath(value);
  return redacted === undefined ? undefined : redacted.value;
}

/**
 * Keys whose value may name a location, in priority order.
 *
 * Search patterns are deliberately absent. `grep` and `glob` take a required
 * `pattern` and an *optional* `path`, so the ordinary call carries the pattern
 * only — and a pattern is what the user is searching *for*, which is exactly
 * what an observer must never see (`AKIA…`, `password = "…"`, an internal
 * hostname). `name` is absent for the same reason: it names a thing, not a
 * place. A row that ends up with no target simply shows no target.
 */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'target'];

/**
 * Extract a redacted target out of a JSON argument string, tolerating junk.
 *
 * Shell commands are deliberately excluded: a command line can carry a path, a
 * token or a secret, so it is never inspected for a target.
 */
export function targetFromArguments(rawArguments: string): RedactedTarget | undefined {
  if (typeof rawArguments !== 'string' || rawArguments.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const target = redactPath(value);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** Longest Session title we forward. */
export const MAX_TITLE = 80;

/**
 * Absolute, home-relative, drive-rooted and UNC path tokens inside free text.
 *
 * A leading `/` only starts a match when a path character follows it, so prose
 * such as `读/写` or `and/or` is left alone; relative paths are not touched
 * either, because they say nothing about where the user keeps files.
 *
 * "Path character" has to mean Unicode, not ASCII: `redactPath` already reduced
 * `/数据/客户/名单.csv` to `名单.csv` when it arrived as a structured target, but
 * the same path inside a plan line or a Session title matched nothing here and
 * travelled to the browser verbatim — a direct contradiction of the promise this
 * module exists to keep. `\p{L}\p{N}` covers CJK, Cyrillic, Greek and the rest.
 * The `≥2 segments` rule below is what still keeps `读/写` (one segment after the
 * slash) and `and/or` out of the rewrite, so widening the character class does
 * not start eating prose.
 *
 * `\\\\` is the UNC form (`\\server\share\file`), which the drive-rooted branch
 * never covered: its first segment is a host name, so it cannot be expressed by
 * the `[A-Za-z]:` alternative.
 */
const ABSOLUTE_PATH_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|~[\\/]|(?<![\p{L}\p{N}._@+~-])\/)[\p{L}\p{N}._@+-][^\s"'`<>|,;()\[\]{}]*/gu;

/**
 * Reduce every absolute-looking path inside Agent-authored prose to its safe
 * basename.
 *
 * Plan lines and Session titles are free text the Agent (or the user's first
 * prompt) wrote, so they need the same guarantee as a structured target: the
 * browser may learn *which* file, never *where*. A secret-bearing name is
 * replaced by the fixed placeholder instead of its basename.
 *
 * A token needs at least two segments to count as a path worth rewriting. That
 * keeps ordinary prose intact — `and/or` contains a `/`, but `/or` reveals no
 * directory at all, and rewriting it would silently eat the slash.
 */
export function redactInlinePaths(value: string): string {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(ABSOLUTE_PATH_TOKEN, (token) => {
    const segments = token
      .split(/[\\/]+/)
      .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length < 2) return token;
    const target = redactPath(token);
    return target === undefined ? token : target.value;
  });
}

/**
 * How a tool name should be displayed.
 *
 * A tool name is a *name*, not a location — the allow-list already permits it.
 * Running it through `redactPath` turned `mcp__vault__read_credential` into
 * 「读取敏感配置文件」 and threw away the one detail an approval is actually about.
 * Names that really are paths (an absolute executable) are still reduced to a
 * basename, which is the case `redactPath` was written for.
 */
export function displayNameForTool(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name === '') return undefined;
  if (!/[\\/]/.test(name)) {
    const clipped = clipLabel(name, 32);
    return clipped === '' ? undefined : clipped;
  }
  const target = redactPath(name);
  return target === undefined ? undefined : target.value;
}

/** Shorten a plain label (a tool name, a phase word) for display. */
export function clipLabel(value: string, max = 32): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whitelist an error code: `QUOTA`, `AUTH`, … — never a free-form message. */
export function safeErrorLabel(code: unknown): string {
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : 'agent-error';
}
