import { describe, expect, it } from 'vitest';
import {
  approvalActivity,
  categoryOf,
  errorActivity,
  fileKindOf,
  retryActivity,
  sanitizeBasename,
  settledActivity,
  targetFromArguments,
  toolActivity,
} from '../src/host/normalize';

describe('tool classification', () => {
  it('maps the shipped DSH tool families', () => {
    expect(categoryOf('bash')).toBe('shell');
    expect(categoryOf('terminal_send')).toBe('shell');
    expect(categoryOf('read')).toBe('file-read');
    expect(categoryOf('read_image')).toBe('file-read');
    expect(categoryOf('write')).toBe('file-write');
    expect(categoryOf('edit')).toBe('file-write');
    expect(categoryOf('apply_patch')).toBe('file-write');
    expect(categoryOf('glob')).toBe('search');
    expect(categoryOf('grep')).toBe('search');
    expect(categoryOf('session_search')).toBe('search');
    expect(categoryOf('web_fetch')).toBe('browser');
    expect(categoryOf('todo_write')).toBe('reasoning');
    expect(categoryOf('')).toBe('other');
  });

  it('classifies the v2 families: test, subagent, reasoning', () => {
    expect(categoryOf('run_tests')).toBe('test');
    expect(categoryOf('vitest')).toBe('test');
    expect(categoryOf('subagent')).toBe('subagent');
    expect(categoryOf('spawn_teammate')).toBe('subagent');
    expect(categoryOf('wait_agent')).toBe('subagent');
    expect(categoryOf('team_task_update')).toBe('subagent');
    expect(categoryOf('create_goal')).toBe('reasoning');
    expect(categoryOf('ask_user_question')).toBe('reasoning');
    expect(categoryOf('schedule_create')).toBe('reasoning');
  });

  it('falls back to `other` for a tool nobody registered', () => {
    expect(categoryOf('some_mcp_tool_42')).toBe('other');
    expect(categoryOf('  weird tool  ')).toBe('other');
  });

  it('derives the file flavour', () => {
    expect(fileKindOf('read')).toBe('read');
    expect(fileKindOf('write')).toBe('write');
    expect(fileKindOf('edit')).toBe('edit');
    expect(fileKindOf('apply_patch')).toBe('edit');
    expect(fileKindOf('lsp_rename')).toBe('edit');
    expect(fileKindOf('bash')).toBeUndefined();
  });
});

describe('path privacy', () => {
  it('keeps only the basename, never the directory or the user', () => {
    expect(sanitizeBasename('/Users/alice/work/secret-plan.md')).toBe('secret-plan.md');
    expect(sanitizeBasename('~/.ssh/id_rsa')).toBe('id_rsa');
    expect(sanitizeBasename('C:\\Users\\bob\\notes.txt')).toBe('notes.txt');
    expect(sanitizeBasename('src/')).toBe('src');
    expect(sanitizeBasename('https://example.com/a/b.pdf?x=1')).toBe('b.pdf');
  });

  it('rejects values that carry no filename', () => {
    expect(sanitizeBasename('')).toBeUndefined();
    expect(sanitizeBasename('   ')).toBeUndefined();
    expect(sanitizeBasename('~')).toBeUndefined();
    expect(sanitizeBasename('/')).toBeUndefined();
    expect(sanitizeBasename('C:')).toBeUndefined();
  });

  it('truncates absurd names', () => {
    const long = 'a'.repeat(120);
    const value = sanitizeBasename(long);
    expect(value).toBeDefined();
    expect(value?.length).toBe(40);
    expect(value?.endsWith('…')).toBe(true);
  });

  it('reads a target out of JSON arguments, and never throws on junk', () => {
    expect(targetFromArguments('{"file_path":"/Users/x/report.md"}')).toBe('report.md');
    expect(targetFromArguments('{"pattern":"**/*.ts"}')).toBe('*.ts');
    expect(targetFromArguments('{"other":1}')).toBeUndefined();
    expect(targetFromArguments('not json at all')).toBeUndefined();
    expect(targetFromArguments('')).toBeUndefined();
    expect(targetFromArguments('[]')).toBeUndefined();
  });
});

describe('activity rows', () => {
  const at = 1_700_000_000_000;
  const sessionId = 's1';

  it('marks file tools as file nodes with a safe target', () => {
    const row = toolActivity({
      id: 'call-1',
      sessionId,
      rawName: 'read',
      argumentsJson: '{"file_path":"/Users/alice/secret/plan.md"}',
      at,
      turn: 1,
      step: 2,
    });
    expect(row.type).toBe('file');
    expect(row.fileKind).toBe('read');
    expect(row.category).toBe('file-read');
    expect(row.safeTarget).toBe('plan.md');
    expect(row.status).toBe('running');
    expect(row.sessionId).toBe(sessionId);
    expect(row.turn).toBe(1);
    expect(row.step).toBe(2);
    expect(JSON.stringify(row)).not.toContain('alice');
    expect(JSON.stringify(row)).not.toContain('/Users');
  });

  it('never forwards shell command arguments', () => {
    const row = toolActivity({
      id: 'call-2',
      sessionId,
      rawName: 'bash',
      argumentsJson: '{"command":"cat /etc/passwd"}',
      at,
    });
    expect(row.type).toBe('tool');
    expect(row.category).toBe('shell');
    expect(row.safeTarget).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('passwd');
  });

  it('whitelists error codes only', () => {
    expect(errorActivity(at, 'e1', sessionId, 'QUOTA').label).toBe('QUOTA');
    expect(errorActivity(at, 'e2', sessionId, 'upstream said: boom').label).toBe('agent-error');
    expect(errorActivity(at, 'e3', sessionId, undefined).label).toBe('agent-error');
  });

  it('labels a retry without exposing the failure body', () => {
    const row = retryActivity(at, 'retry:1:1:2', sessionId, 2);
    expect(row.label).toBe('retry-2');
    expect(row.category).toBe('reasoning');
    expect(row.status).toBe('waiting');
  });

  it('approval rows carry no arguments', () => {
    const row = approvalActivity(at, 'a1', sessionId, '/usr/local/bin/bash');
    expect(row.type).toBe('approval');
    expect(row.status).toBe('waiting');
    expect(row.category).toBe('approval');
    expect(row.safeTarget).toBe('bash');
    expect(Object.keys(row).sort()).toEqual(
      ['category', 'id', 'label', 'safeTarget', 'sessionId', 'startedAt', 'status', 'type'],
    );
  });

  it('settles a row with a duration and keeps it immutable', () => {
    const row = toolActivity({ id: 'c', sessionId, rawName: 'grep', argumentsJson: '{}', at });
    const settled = settledActivity(row, 'success', at + 120);
    expect(settled.status).toBe('success');
    expect(settled.duration).toBe(120);
    expect(settled.endedAt).toBe(at + 120);
    expect(row.status).toBe('running');
  });

  it('the DTO has no field that could carry forbidden content', () => {
    const row = toolActivity({
      id: 'c',
      sessionId,
      rawName: 'bash',
      argumentsJson: '{"command":"rm -rf /tmp/x"}',
      at,
    });
    const keys = Object.keys(row);
    for (const forbidden of [
      'rawArguments',
      'rawCommand',
      'fileContent',
      'reasoningText',
      'userMessage',
      'rawToolResult',
      'arguments',
      'text',
      'content',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(row)).not.toContain('rm -rf');
  });
});
