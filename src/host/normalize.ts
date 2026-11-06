/**
 * DSH event → activity normalization (spec §2.4, §2.5, §8).
 *
 * This is the security boundary of the plugin: everything the browser may show
 * is produced here from an explicit whitelist. Tool arguments, file contents,
 * prompts, reasoning and full paths never cross it — only a tool family, a
 * truncated basename, a status and timings do.
 */
import type {
  OrbitActivity,
  OrbitFileKind,
  OrbitToolCategory,
} from '../shared/protocol';

const SHELL_TOOLS = new Set([
  'bash',
  'run_code',
  'run_command',
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_close',
  'terminal_list',
  'terminal_signal',
]);

const FILE_READ_TOOLS = new Set([
  'read',
  'read_image',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_completion',
  'lsp_signature',
  'lsp_inlay_hints',
]);

const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'lsp_rename', 'lsp_format']);

const SEARCH_TOOLS = new Set([
  'glob',
  'grep',
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_trace',
  'session_event_trace',
  'web_search',
  'find_skills',
]);

const BROWSER_TOOLS = new Set(['web_fetch', 'browser', 'browser_use', 'computer_use']);

/** Longest display name / target we will forward. */
const MAX_LABEL = 40;
const MAX_TOOL_NAME = 32;

/** Tool families for the visual legend; order is stable for the Client. */
export function classifyTool(rawName: string): OrbitToolCategory {
  const name = normalizeName(rawName);
  if (name === '') return 'other';
  if (SHELL_TOOLS.has(name) || name.startsWith('terminal') || name.startsWith('bash')) return 'shell';
  if (BROWSER_TOOLS.has(name) || name.startsWith('browser') || name.startsWith('cua_')) return 'browser';
  if (FILE_WRITE_TOOLS.has(name)) return 'file-write';
  if (FILE_READ_TOOLS.has(name) || name.startsWith('read')) return 'file-read';
  if (SEARCH_TOOLS.has(name) || name.startsWith('glob') || name.startsWith('grep')) return 'search';
  return 'other';
}

/** Read / write / edit flavour, or `undefined` when the tool is not a file op. */
export function fileKindOf(rawName: string): OrbitFileKind | undefined {
  const name = normalizeName(rawName);
  if (name === '') return undefined;
  if (name === 'write') return 'write';
  if (name === 'edit' || name === 'apply_patch' || name === 'lsp_rename' || name === 'lsp_format') {
    return 'edit';
  }
  if (name.startsWith('read') || FILE_READ_TOOLS.has(name)) return 'read';
  return undefined;
}

function normalizeName(rawName: string): string {
  return typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
}

/** Keys whose value may name a path or pattern, in priority order. */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'target', 'pattern', 'name', 'command'];

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
  rawName: string;
  argumentsJson: string;
  at: number;
}

/** Build the running row for one `tool/call`. */
export function toolActivity(input: ToolCallInput): OrbitActivity {
  const category = classifyTool(input.rawName);
  const fileKind = fileKindOf(input.rawName);
  const wantsTarget = fileKind !== undefined || category === 'search';
  const target = wantsTarget ? targetFromArguments(input.argumentsJson) : undefined;
  const name = input.rawName.slice(0, MAX_TOOL_NAME);

  const base = {
    id: input.id,
    name,
    status: 'running' as const,
    timestamp: input.at,
    category,
  };

  if (fileKind !== undefined) {
    return target === undefined
      ? { ...base, type: 'file', fileKind }
      : { ...base, type: 'file', fileKind, target };
  }
  return target === undefined
    ? { ...base, type: 'tool' }
    : { ...base, type: 'tool', target };
}

/** Row for an approval ask; carries no tool arguments by construction. */
export function approvalActivity(at: number, toolName: string | undefined, id: string): OrbitActivity {
  const target = typeof toolName === 'string' ? sanitizeBasename(toolName) : undefined;
  return target === undefined
    ? { id, type: 'approval', name: 'approval', status: 'waiting', timestamp: at }
    : { id, type: 'approval', name: 'approval', status: 'waiting', timestamp: at, target };
}

/**
 * Row for an Agent-level failure. The DSH failure code is a short machine label
 * (`QUOTA`, `AUTH`, …) and is safe to show; messages are not forwarded.
 */
export function errorActivity(at: number, code: string | undefined, id: string): OrbitActivity {
  const name = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : 'agent-error';
  return { id, type: 'agent', name, status: 'error', timestamp: at };
}
