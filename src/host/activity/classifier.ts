/**
 * The Activity Classifier — tool name + safe argument *shape* → one of the 13
 * families of spec §3.2.
 *
 * Rules are ordered and explainable:
 *  1. exact tool-name registry (highest confidence);
 *  2. prefix rules for tool families that ship with a naming convention;
 *  3. for shell tools only, a *category* keyword test on the command string —
 *     the string is inspected in-process and never leaves the Host, and only
 *     the resulting category survives.
 *
 * A tool nobody knows becomes `unknown`; it is never dropped, and its name is
 * never guessed to be a test/build just because it contains that word.
 */
import type { OrbitConfidence, OrbitFileKind, OrbitToolCategory } from '../../shared/task-context-types';

export interface ClassifyInput {
  /** Raw DSH tool name. */
  name: string;
  /** Raw JSON argument string; only used to *categorize* shell tools. */
  argumentsJson?: string;
}

export interface Classification {
  category: OrbitToolCategory;
  /** Read / write / edit flavour for file-shaped tools. */
  fileKind?: OrbitFileKind;
  confidence: OrbitConfidence;
  /** True when the category came from analysing a command string. */
  inferredFromArguments: boolean;
}

const EXACT: Record<string, OrbitToolCategory> = {
  // ---- file reads ----------------------------------------------------------
  read: 'file_read',
  read_image: 'file_read',
  ls: 'file_read',
  view: 'file_read',
  // ---- file writes ---------------------------------------------------------
  write: 'file_write',
  edit: 'file_write',
  apply_patch: 'file_write',
  str_replace: 'file_write',
  str_replace_editor: 'file_write',
  lsp_rename: 'file_write',
  lsp_format: 'file_write',
  mkdir: 'file_write',
  create_directory: 'file_write',
  // ---- commands ------------------------------------------------------------
  bash: 'command',
  run_code: 'command',
  run_command: 'command',
  exec: 'command',
  execute: 'command',
  pwsh: 'command',
  powershell: 'command',
  terminal_open: 'command',
  terminal_send: 'command',
  terminal_read: 'command',
  terminal_close: 'command',
  terminal_list: 'command',
  terminal_signal: 'command',
  job_output: 'command',
  job_kill: 'command',
  job_list: 'command',
  // ---- search --------------------------------------------------------------
  glob: 'search',
  grep: 'search',
  find: 'search',
  search: 'search',
  web_search: 'search',
  session_search: 'search',
  session_event_search: 'search',
  session_event_read: 'search',
  session_trace: 'search',
  session_event_trace: 'search',
  session_query: 'search',
  find_skills: 'search',
  skill: 'search',
  // ---- tests / builds ------------------------------------------------------
  run_tests: 'test',
  test: 'test',
  vitest: 'test',
  pytest: 'test',
  jest: 'test',
  cargo_test: 'test',
  go_test: 'test',
  build: 'build',
  tsc: 'build',
  esbuild: 'build',
  webpack: 'build',
  vite: 'build',
  make: 'build',
  // ---- inspection ----------------------------------------------------------
  lsp_diagnostics: 'inspection',
  lsp_symbols: 'inspection',
  lsp_completion: 'inspection',
  lsp_signature: 'inspection',
  lsp_inlay_hints: 'inspection',
  // ---- api / database ------------------------------------------------------
  web_fetch: 'api',
  http_request: 'api',
  query_api: 'api',
  sql_query: 'database',
  db_query: 'database',
  // ---- orchestration / reasoning ------------------------------------------
  todo_write: 'reasoning',
  create_goal: 'reasoning',
  update_goal: 'reasoning',
  get_goal: 'reasoning',
  ask_user_question: 'reasoning',
  plan: 'reasoning',
  plan_mode: 'reasoning',
  subagent: 'reasoning',
  subagent_fork: 'reasoning',
  spawn_teammate: 'reasoning',
  send_message: 'reasoning',
  wait_agent: 'reasoning',
  list_agents: 'reasoning',
  interrupt_agent: 'reasoning',
  list_subagent_models: 'reasoning',
  workflow: 'reasoning',
  team_task_create: 'reasoning',
  team_task_get: 'reasoning',
  team_task_list: 'reasoning',
  team_task_update: 'reasoning',
  present: 'response',
};

const PREFIXES: ReadonlyArray<readonly [string, OrbitToolCategory]> = [
  ['terminal', 'command'],
  ['bash', 'command'],
  ['pwsh', 'command'],
  ['job_', 'command'],
  ['lsp_', 'inspection'],
  ['read', 'file_read'],
  ['write', 'file_write'],
  ['edit', 'file_write'],
  ['glob', 'search'],
  ['grep', 'search'],
  ['session_', 'search'],
  ['web_', 'api'],
  ['http', 'api'],
  ['browser', 'api'],
  ['cua_', 'api'],
  ['team_', 'reasoning'],
  ['subagent', 'reasoning'],
  ['todo', 'reasoning'],
  ['goal', 'reasoning'],
  ['schedule_', 'reasoning'],
  ['skill', 'search'],
];

/** Shell-family tools whose command string may refine the category. */
const SHELL_TOOLS = new Set([
  'bash',
  'run_command',
  'run_code',
  'exec',
  'execute',
  'pwsh',
  'powershell',
  'terminal_send',
]);

/** Command keywords, most specific first. Only the *category* survives. */
const COMMAND_RULES: ReadonlyArray<readonly [RegExp, OrbitToolCategory]> = [
  [
    /\b(pytest|vitest|jest|mocha|cargo test|go test|npm (run )?test|pnpm (run )?test|yarn test|make test)\b/i,
    'test',
  ],
  [
    /\b(npm run build|pnpm (run )?build|yarn build|cargo build|go build|make\b|tsc\b|esbuild|webpack|vite build|docker build)\b/i,
    'build',
  ],
  [/\b(psql|mysql|sqlite3?|redis-cli|mongo(d)?|clickhouse)\b/i, 'database'],
  [/\b(curl|wget|http|xh|fetch)\b/i, 'api'],
  [/\b(git (diff|status|log|show|branch)|gh pr|gh run)\b/i, 'inspection'],
  // Deliberately no file_read / file_write rules: a shell call that happens to
  // mention `cat` or `rm` is still an opaque command to the reader, and
  // mislabelling it would over-claim what we know.
  [/\b(rg|ag|ack|fd)\b/i, 'search'],
];

function normalizeName(rawName: string): string {
  return typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
}

/** Pull a shell command string out of JSON arguments without keeping it. */
function commandOf(argumentsJson: string | undefined): string {
  if (typeof argumentsJson !== 'string' || argumentsJson.trim() === '') return '';
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    const value = parsed['command'] ?? parsed['cmd'] ?? parsed['script'] ?? parsed['command_line'];
    return typeof value === 'string' ? value.slice(0, 2000) : '';
  } catch {
    return '';
  }
}

/** First matching command rule, in the documented order. */
function refineCommand(command: string): OrbitToolCategory | undefined {
  if (command === '') return undefined;
  for (const [pattern, category] of COMMAND_RULES) {
    if (pattern.test(command)) return category;
  }
  return undefined;
}

/** Classify one tool call. Pure; never throws. */
export function classify(input: ClassifyInput): Classification {
  const name = normalizeName(input.name);
  if (name === '') return { category: 'unknown', confidence: 'low', inferredFromArguments: false };

  const exact = EXACT[name];
  if (exact !== undefined) {
    // A shell tool registered as `command` can still be refined by what it
    // actually runs (`pnpm vitest run` is a test, not an opaque command).
    if (exact === 'command' && SHELL_TOOLS.has(name)) {
      const refined = refineCommand(commandOf(input.argumentsJson));
      if (refined !== undefined) {
        return { category: refined, confidence: 'medium', inferredFromArguments: true };
      }
    }
    return {
      category: exact,
      ...(fileKindOfName(name) === undefined ? {} : { fileKind: fileKindOfName(name) }),
      confidence: 'high',
      inferredFromArguments: false,
    };
  }

  for (const [prefix, category] of PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    return {
      category,
      ...(fileKindOfName(name) === undefined ? {} : { fileKind: fileKindOfName(name) }),
      confidence: 'medium',
      inferredFromArguments: false,
    };
  }

  // A shell tool we do not know by name can still be recognized by what it runs.
  if (SHELL_TOOLS.has(name)) {
    const refined = refineCommand(commandOf(input.argumentsJson));
    if (refined !== undefined) {
      return { category: refined, confidence: 'medium', inferredFromArguments: true };
    }
    return { category: 'command', confidence: 'medium', inferredFromArguments: true };
  }

  // Unknown tool: keep it visible, say so honestly.
  return { category: 'unknown', confidence: 'low', inferredFromArguments: false };
}

/** Read / write / edit flavour, or `undefined` when the tool is not a file op. */
export function fileKindOfName(rawName: string): OrbitFileKind | undefined {
  const name = normalizeName(rawName);
  if (name === '') return undefined;
  if (name === 'write' || name === 'mkdir' || name === 'create_directory') return 'write';
  if (
    name === 'edit' ||
    name === 'apply_patch' ||
    name === 'lsp_rename' ||
    name === 'lsp_format' ||
    name === 'str_replace' ||
    name === 'str_replace_editor'
  ) {
    return 'edit';
  }
  if (name.startsWith('read') || EXACT[name] === 'file_read') return 'read';
  return undefined;
}

/** True when a category is worth a file target in the row. */
export function wantsTarget(category: OrbitToolCategory, fileKind: OrbitFileKind | undefined): boolean {
  if (fileKind !== undefined) return true;
  return category === 'search' || category === 'inspection';
}

/** Every category, in the order the legend lists them. */
export const ALL_CATEGORIES: OrbitToolCategory[] = [
  'reasoning',
  'file_read',
  'file_write',
  'command',
  'search',
  'build',
  'test',
  'api',
  'database',
  'inspection',
  'approval',
  'response',
  'unknown',
];
