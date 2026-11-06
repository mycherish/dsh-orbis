import { describe, expect, it } from 'vitest';
import {
  approvalActivity,
  classifyTool,
  errorActivity,
  fileKindOf,
  sanitizeBasename,
  targetFromArguments,
  toolActivity,
} from '../src/host/normalize';

describe('tool classification', () => {
  it('maps the shipped DSH tool families', () => {
    expect(classifyTool('bash')).toBe('shell');
    expect(classifyTool('terminal_send')).toBe('shell');
    expect(classifyTool('read')).toBe('file-read');
    expect(classifyTool('read_image')).toBe('file-read');
    expect(classifyTool('write')).toBe('file-write');
    expect(classifyTool('edit')).toBe('file-write');
    expect(classifyTool('apply_patch')).toBe('file-write');
    expect(classifyTool('glob')).toBe('search');
    expect(classifyTool('grep')).toBe('search');
    expect(classifyTool('session_search')).toBe('search');
    expect(classifyTool('web_fetch')).toBe('browser');
    expect(classifyTool('todo_write')).toBe('other');
    expect(classifyTool('')).toBe('other');
  });

  it('derives the file flavour', () => {
    expect(fileKindOf('read')).toBe('read');
    expect(fileKindOf('write')).toBe('write');
    expect(fileKindOf('edit')).toBe('edit');
    expect(fileKindOf('apply_patch')).toBe('edit');
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

  it('marks file tools as file nodes with a safe target', () => {
    const row = toolActivity({
      id: 'call-1',
      rawName: 'read',
      argumentsJson: '{"file_path":"/Users/alice/secret/plan.md"}',
      at,
    });
    expect(row.type).toBe('file');
    expect(row.fileKind).toBe('read');
    expect(row.category).toBe('file-read');
    expect(row.target).toBe('plan.md');
    expect(row.status).toBe('running');
    expect(JSON.stringify(row)).not.toContain('alice');
    expect(JSON.stringify(row)).not.toContain('/Users');
  });

  it('never forwards shell command arguments', () => {
    const row = toolActivity({
      id: 'call-2',
      rawName: 'bash',
      argumentsJson: '{"command":"cat /etc/passwd"}',
      at,
    });
    expect(row.type).toBe('tool');
    expect(row.category).toBe('shell');
    expect(row.target).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('passwd');
  });

  it('whitelists error codes only', () => {
    expect(errorActivity(at, 'QUOTA', 'e1').name).toBe('QUOTA');
    expect(errorActivity(at, 'upstream said: boom', 'e2').name).toBe('agent-error');
    expect(errorActivity(at, undefined, 'e3').name).toBe('agent-error');
  });

  it('approval rows carry no arguments', () => {
    const row = approvalActivity(at, 'bash', 'a1');
    expect(row.type).toBe('approval');
    expect(row.status).toBe('waiting');
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'status', 'target', 'timestamp', 'type']);
  });
});
