/**
 * DSH event → activity normalization (the v2 unified Activity DTO).
 *
 * This is the security boundary of the plugin: everything the browser may show
 * is produced here from an explicit whitelist. Tool arguments, commands, file
 * contents, prompts, reasoning and full paths never cross it — only a tool
 * family, a truncated basename, a status and timings do.
 */
import {
  type OrbitActivity,
  type OrbitActivityStatus,
  type OrbitFileKind,
  type OrbitToolCategory,
} from '../shared/protocol';
import { CATEGORY_LABEL, categoryOf, fileKindOf } from './categories';

export { categoryOf, fileKindOf };

/** Longest display label / safe target we will forward. */
const MAX_LABEL = 40;
const MAX_TOOL_NAME = 32;

function normalizeName(rawName: string): string {
  return typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
}

/** Keys whose value may name a path or pattern, in priority order. */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'target', 'pattern', 'name'];

/**
 * Reduce a path-like string to a display-only basename.
 *
 * Directories, user names, home prefixes and absolute roots are dropped, so a
 * leaked target can never identify where the user keeps their files.
 */
export function sanitizeBasename(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '') return undefined;

  // Keep only the last segment: handles POSIX, Windows and URL-ish inputs.
  const segments = cleaned.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (segments.length === 0) return undefined;
  const last = segments[segments.length - 1] ?? '';
  // A bare drive letter or separator is not a filename.
  if (/^[a-zA-Z]:$/.test(last)) return undefined;
  // Drop a query/fragment, then only the characters no filesystem allows.
  // Glob metacharacters (`*`, `?`) are meaningful in a pattern and are kept.
  const withoutQuery = last.replace(/[?#].*$/, '').replace(/[<>"|:]/g, '').trim();
  if (withoutQuery === '' || withoutQuery === '~') return undefined;
  return withoutQuery.length > MAX_LABEL ? `${withoutQuery.slice(0, MAX_LABEL - 1)}…` : withoutQuery;
}

/** Extract a safe target from a JSON tool-argument string, tolerating junk. */
export function targetFromArguments(rawArguments: string): string | undefined {
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
    const target = sanitizeBasename(value);
    if (target !== undefined) return target;
  }
  return undefined;
}

export interface ToolCallInput {
  id: string;
  sessionId: string;
  rawName: string;
  argumentsJson: string;
  /** Epoch milliseconds when the call started. */
  at: number;
  turn?: number;
  step?: number;
}

/** Build the running row for one `tool/call`. */
export function toolActivity(input: ToolCallInput): OrbitActivity {
  const category = categoryOf(input.rawName);
  const fileKind = fileKindOf(input.rawName);
  // A target is only extracted for file-shaped tools: a shell command line may
  // itself carry a path or a secret, so it is never inspected.
  const wantsTarget = fileKind !== undefined || category === 'search';
  const target = wantsTarget ? targetFromArguments(input.argumentsJson) : undefined;
  const raw = typeof input.rawName === 'string' ? input.rawName.trim() : '';
  const label = (raw === '' ? CATEGORY_LABEL[category] : raw).slice(0, MAX_TOOL_NAME);

  const base: OrbitActivity = {
    id: input.id,
    sessionId: input.sessionId,
    type: 'tool',
    category,
    label,
    status: 'running',
    startedAt: input.at,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.step === undefined ? {} : { step: input.step }),
    ...(target === undefined ? {} : { safeTarget: target }),
  };

  if (fileKind !== undefined) {
    const row: OrbitActivity = { ...base, type: 'file', fileKind };
    if (target !== undefined) row.safeTarget = target;
    return row;
  }
  return base;
}

/** Row for an approval ask; carries no tool arguments by construction. */
export function approvalActivity(
  at: number,
  id: string,
  sessionId: string,
  toolName?: string,
  location?: { turn?: number; step?: number },
): OrbitActivity {
  const target = typeof toolName === 'string' ? sanitizeBasename(toolName) : undefined;
  return {
    id,
    sessionId,
    type: 'approval',
    category: 'approval',
    label: 'approval',
    status: 'waiting',
    startedAt: at,
    ...(location?.turn === undefined ? {} : { turn: location.turn }),
    ...(location?.step === undefined ? {} : { step: location.step }),
    ...(target === undefined ? {} : { safeTarget: target }),
  };
}

/**
 * Row for an Agent-level failure. The DSH failure code is a short machine label
 * (`QUOTA`, `AUTH`, …) and is safe to show; messages are not forwarded.
 */
export function errorActivity(at: number, id: string, sessionId: string, code?: string): OrbitActivity {
  const label = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : 'agent-error';
  return {
    id,
    sessionId,
    type: 'agent',
    category: 'other',
    label,
    status: 'error',
    startedAt: at,
  };
}

/** Row for a model retry; the retry count is the only detail that survives. */
export function retryActivity(at: number, id: string, sessionId: string, attempt: number): OrbitActivity {
  const label = Number.isFinite(attempt) && attempt > 0 ? `retry-${Math.floor(attempt)}` : 'retry';
  return {
    id,
    sessionId,
    type: 'agent',
    category: 'reasoning',
    label,
    status: 'waiting',
    startedAt: at,
  };
}

/** Settle a row in place: returns a new object so React sees the change. */
export function settledActivity(
  row: OrbitActivity,
  status: OrbitActivityStatus,
  at: number,
): OrbitActivity {
  const duration = Math.max(0, at - row.startedAt);
  return { ...row, status, endedAt: at, duration };
}

/** Exported for the Workspace legend so both halves agree on the vocabulary. */
export const TOOL_CATEGORIES: OrbitToolCategory[] = [
  'file-read',
  'file-write',
  'shell',
  'search',
  'test',
  'browser',
  'subagent',
  'reasoning',
  'approval',
  'other',
];

export function categoryLabel(category: OrbitToolCategory): string {
  return CATEGORY_LABEL[category];
}

export function fileKindLabel(fileKind: OrbitFileKind): string {
  return fileKind === 'read' ? '读取' : fileKind === 'write' ? '写入' : '修改';
}

/** Normalized display name for a tool, used when only the family is safe. */
export function displayNameFor(rawName: string): string {
  const name = normalizeName(rawName);
  if (name === '') return 'tool';
  return name.slice(0, MAX_TOOL_NAME);
}
