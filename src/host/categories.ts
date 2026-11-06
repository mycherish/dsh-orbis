/**
 * The tool-category registry.
 *
 * The raw tool name is the only thing we look at, and the only thing we keep
 * from it is which *family* it belongs to. A tool nobody registered is
 * `other` — never dropped (an unknown tool still means "the Agent is working")
 * and never guessed from its arguments.
 */
import type { OrbitFileKind, OrbitToolCategory } from '../shared/protocol';

/** Exact tool-name registrations. Lower-cased on lookup. */
const REGISTRY: Record<string, OrbitToolCategory> = {
  // ---- shell / process -----------------------------------------------------
  bash: 'shell',
  run_code: 'shell',
  run_command: 'shell',
  execute: 'shell',
  exec: 'shell',
  terminal_open: 'shell',
  terminal_send: 'shell',
  terminal_read: 'shell',
  terminal_close: 'shell',
  terminal_list: 'shell',
  terminal_signal: 'shell',
  pwsh: 'shell',
  powershell: 'shell',
  job_output: 'shell',
  job_kill: 'shell',
  job_list: 'shell',

  // ---- file reads ----------------------------------------------------------
  read: 'file-read',
  read_image: 'file-read',
  ls: 'file-read',
  view: 'file-read',
  lsp_diagnostics: 'file-read',
  lsp_symbols: 'file-read',
  lsp_completion: 'file-read',
  lsp_signature: 'file-read',
  lsp_inlay_hints: 'file-read',

  // ---- file writes ---------------------------------------------------------
  write: 'file-write',
  edit: 'file-write',
  apply_patch: 'file-write',
  str_replace: 'file-write',
  str_replace_editor: 'file-write',
  lsp_rename: 'file-write',
  lsp_format: 'file-write',
  create_directory: 'file-write',
  mkdir: 'file-write',

  // ---- search --------------------------------------------------------------
  glob: 'search',
  grep: 'search',
  search: 'search',
  find: 'search',
  web_search: 'search',
  session_search: 'search',
  session_event_search: 'search',
  session_event_read: 'search',
  session_trace: 'search',
  session_event_trace: 'search',
  session_query: 'search',
  find_skills: 'search',
  skill: 'search',

  // ---- tests ---------------------------------------------------------------
  run_tests: 'test',
  test: 'test',
  tests: 'test',
  vitest: 'test',
  pytest: 'test',
  jest: 'test',
  cargo_test: 'test',
  go_test: 'test',

  // ---- browser / network ---------------------------------------------------
  web_fetch: 'browser',
  browser: 'browser',
  browser_use: 'browser',
  computer_use: 'browser',
  cua: 'browser',

  // ---- orchestration -------------------------------------------------------
  subagent: 'subagent',
  subagent_fork: 'subagent',
  spawn_teammate: 'subagent',
  send_message: 'subagent',
  wait_agent: 'subagent',
  list_agents: 'subagent',
  interrupt_agent: 'subagent',
  list_subagent_models: 'subagent',
  workflow: 'subagent',
  team_task_create: 'subagent',
  team_task_get: 'subagent',
  team_task_list: 'subagent',
  team_task_update: 'subagent',

  // ---- reasoning / planning ------------------------------------------------
  todo_write: 'reasoning',
  create_goal: 'reasoning',
  update_goal: 'reasoning',
  get_goal: 'reasoning',
  ask_user_question: 'reasoning',
  plan: 'reasoning',
  plan_mode: 'reasoning',
};

/** Prefix rules, applied after the exact registry misses. */
const PREFIXES: ReadonlyArray<readonly [string, OrbitToolCategory]> = [
  ['terminal', 'shell'],
  ['bash', 'shell'],
  ['pwsh', 'shell'],
  ['job_', 'shell'],
  ['lsp_', 'file-read'],
  ['read', 'file-read'],
  ['write', 'file-write'],
  ['edit', 'file-write'],
  ['glob', 'search'],
  ['grep', 'search'],
  ['session_', 'search'],
  ['web_', 'browser'],
  ['browser', 'browser'],
  ['cua_', 'browser'],
  ['team_', 'subagent'],
  ['subagent', 'subagent'],
  ['todo', 'reasoning'],
  ['goal', 'reasoning'],
  ['schedule_', 'reasoning'],
  ['skill', 'search'],
];

/** Registry lookup with an explicit `other` fallback. */
export function categoryOf(rawName: string): OrbitToolCategory {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  if (name === '') return 'other';
  const exact = REGISTRY[name];
  if (exact !== undefined) return exact;
  for (const [prefix, category] of PREFIXES) {
    if (name.startsWith(prefix)) return category;
  }
  return 'other';
}

/** Read / write / edit flavour, or `undefined` when the tool is not a file op. */
export function fileKindOf(rawName: string): OrbitFileKind | undefined {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  if (name === '') return undefined;
  if (name === 'write' || name === 'create_directory' || name === 'mkdir') return 'write';
  if (name === 'edit' || name === 'apply_patch' || name === 'lsp_rename' || name === 'lsp_format'
    || name === 'str_replace' || name === 'str_replace_editor') {
    return 'edit';
  }
  if (name.startsWith('read') || REGISTRY[name] === 'file-read') return 'read';
  return undefined;
}

/** Chinese display label per family, used where no tool name may be shown. */
export const CATEGORY_LABEL: Record<OrbitToolCategory, string> = {
  'file-read': '读取文件',
  'file-write': '写入文件',
  shell: '执行命令',
  search: '搜索',
  test: '运行测试',
  browser: '访问网络',
  subagent: '协作代理',
  reasoning: '整理思路',
  approval: '等待审批',
  other: '调用工具',
};
