import { describe, expect, it } from 'vitest';
import { classify, fileKindOfName, ALL_CATEGORIES } from '../src/host/activity/classifier';
import {
  isSensitiveName,
  redactPath,
  safeErrorLabel,
  sanitizeBasename,
  targetFromArguments,
} from '../src/host/activity/redactor';
import {
  approvalActivity,
  errorActivity,
  retryActivity,
  settledActivity,
  toolActivity,
} from '../src/host/activity/normalizer';
import { SENSITIVE_TARGET_LABEL } from '../src/shared/task-context-types';

const at = 1_700_000_000_000;
const sessionId = 's1';

describe('activity classifier', () => {
  it('maps the shipped DSH tools to the 13 families', () => {
    expect(classify({ name: 'read' }).category).toBe('file_read');
    expect(classify({ name: 'write' }).category).toBe('file_write');
    expect(classify({ name: 'edit' }).category).toBe('file_write');
    expect(classify({ name: 'bash' }).category).toBe('command');
    expect(classify({ name: 'grep' }).category).toBe('search');
    expect(classify({ name: 'glob' }).category).toBe('search');
    expect(classify({ name: 'web_fetch' }).category).toBe('api');
    expect(classify({ name: 'todo_write' }).category).toBe('reasoning');
    expect(classify({ name: 'present' }).category).toBe('response');
    expect(classify({ name: 'lsp_diagnostics' }).category).toBe('inspection');
    expect(classify({ name: 'vitest' }).category).toBe('test');
    expect(classify({ name: 'sql_query' }).category).toBe('database');
  });

  it('refines a shell call by what it actually runs', () => {
    expect(classify({ name: 'bash', argumentsJson: '{"command":"pnpm vitest run"}' }).category).toBe('test');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"cargo build --release"}' }).category).toBe('build');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"curl -s localhost:8080/health"}' }).category).toBe('api');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"psql -c \\"select 1\\""}' }).category).toBe('database');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"git diff HEAD"}' }).category).toBe('inspection');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"echo hi"}' }).category).toBe('command');
  });

  it('does not call something a test just because the name says test', () => {
    // `latest_notes` starts with "test"? No — but it contains it. It must not
    // become `test`; only an exact name or a real command does.
    expect(classify({ name: 'latest_notes' }).category).toBe('unknown');
    expect(classify({ name: 'contest_report' }).category).toBe('unknown');
  });

  it('degrades honestly for unknown tools and junk input', () => {
    const unknown = classify({ name: 'some_mcp_tool_42' });
    expect(unknown.category).toBe('unknown');
    expect(unknown.confidence).toBe('low');
    expect(classify({ name: '' }).category).toBe('unknown');
    expect(classify({ name: 'bash', argumentsJson: 'not json' }).category).toBe('command');
  });

  it('reports higher confidence for a registered name than for a guess', () => {
    expect(classify({ name: 'read' }).confidence).toBe('high');
    expect(classify({ name: 'lsp_diagnostics' }).confidence).toBe('high');
    expect(classify({ name: 'bash', argumentsJson: '{"command":"pytest"}' }).confidence).toBe('medium');
  });

  it('derives the file flavour', () => {
    expect(fileKindOfName('read')).toBe('read');
    expect(fileKindOfName('write')).toBe('write');
    expect(fileKindOfName('edit')).toBe('edit');
    expect(fileKindOfName('lsp_rename')).toBe('edit');
    expect(fileKindOfName('bash')).toBeUndefined();
  });

  it('covers every declared category', () => {
    expect(ALL_CATEGORIES).toHaveLength(13);
    expect(new Set(ALL_CATEGORIES).size).toBe(13);
  });
});

describe('redaction', () => {
  it('keeps only the basename, never the directory or the user', () => {
    expect(sanitizeBasename('/Users/alice/work/secret-plan.md')).toBe('secret-plan.md');
    expect(sanitizeBasename('~/.ssh/id_rsa')).toBe(SENSITIVE_TARGET_LABEL);
    expect(sanitizeBasename('C:\\Users\\bob\\notes.txt')).toBe('notes.txt');
    expect(sanitizeBasename('https://example.com/a/b.pdf?x=1')).toBe('b.pdf');
  });

  it('masks secret-bearing filenames entirely', () => {
    for (const name of ['.env', '.env.production', 'server.key', 'cert.pem', 'id_rsa', 'credentials.json', 'app.secret']) {
      expect(isSensitiveName(name)).toBe(true);
    }
    const masked = redactPath('/Users/alice/app/.env.local');
    expect(masked?.value).toBe(SENSITIVE_TARGET_LABEL);
    expect(masked?.redacted).toBe(true);
  });

  it('keeps ordinary filenames visible', () => {
    expect(isSensitiveName('hub.ts')).toBe(false);
    expect(isSensitiveName('README.md')).toBe(false);
    expect(isSensitiveName('report.json')).toBe(false);
  });

  it('rejects values that carry no filename', () => {
    expect(sanitizeBasename('')).toBeUndefined();
    expect(sanitizeBasename('   ')).toBeUndefined();
    expect(sanitizeBasename('~')).toBeUndefined();
    expect(sanitizeBasename('/')).toBeUndefined();
    expect(sanitizeBasename('C:')).toBeUndefined();
  });

  it('truncates absurd names', () => {
    const value = sanitizeBasename('a'.repeat(120));
    expect(value?.length).toBe(40);
    expect(value?.endsWith('…')).toBe(true);
  });

  it('reads a target out of JSON arguments, and never throws on junk', () => {
    expect(targetFromArguments('{"file_path":"/Users/x/report.md"}')?.value).toBe('report.md');
    expect(targetFromArguments('{"pattern":"**/*.ts"}')?.value).toBe('*.ts');
    expect(targetFromArguments('{"other":1}')).toBeUndefined();
    expect(targetFromArguments('not json at all')).toBeUndefined();
    expect(targetFromArguments('[]')).toBeUndefined();
  });

  it('whitelists error codes only', () => {
    expect(safeErrorLabel('QUOTA')).toBe('QUOTA');
    expect(safeErrorLabel('upstream said: boom')).toBe('agent-error');
    expect(safeErrorLabel(undefined)).toBe('agent-error');
  });
});

describe('activity rows', () => {
  it('builds a file row with a safe target and full identity', () => {
    const row = toolActivity({
      id: 'call-1',
      sessionId,
      rawName: 'read',
      argumentsJson: '{"file_path":"/Users/alice/secret/plan.md"}',
      at,
      turn: 1,
      step: 2,
    });
    expect(row.category).toBe('file_read');
    expect(row.fileKind).toBe('read');
    expect(row.safeTarget).toBe('plan.md');
    expect(row.status).toBe('running');
    expect(row.callId).toBe('call-1');
    expect(row.sessionId).toBe(sessionId);
    expect(row.turn).toBe(1);
    expect(row.step).toBe(2);
    expect(row.source).toBe('tool');
    expect(row.confidence).toBe('high');
    expect(JSON.stringify(row)).not.toContain('alice');
    expect(JSON.stringify(row)).not.toContain('/Users');
  });

  it('masks a sensitive file even when it is only a basename', () => {
    const row = toolActivity({
      id: 'call-2',
      sessionId,
      rawName: 'read',
      argumentsJson: '{"file_path":"/srv/app/.env.production"}',
      at,
    });
    expect(row.safeTarget).toBe(SENSITIVE_TARGET_LABEL);
    expect(row.redacted).toBe(true);
    expect(JSON.stringify(row)).not.toContain('.env');
  });

  it('never forwards shell command arguments', () => {
    const row = toolActivity({
      id: 'call-3',
      sessionId,
      rawName: 'bash',
      argumentsJson: '{"command":"cat /etc/passwd"}',
      at,
    });
    expect(row.category).toBe('command');
    expect(row.safeTarget).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('passwd');
  });

  it('labels a build/test call by its family, not by its command text', () => {
    const row = toolActivity({
      id: 'call-4',
      sessionId,
      rawName: 'bash',
      argumentsJson: '{"command":"pnpm vitest run --reporter=dot"}',
      at,
    });
    expect(row.category).toBe('test');
    expect(row.label).toBe('执行测试');
    expect(JSON.stringify(row)).not.toContain('vitest');
  });

  it('keeps an unknown tool name, but says the category is unknown', () => {
    const row = toolActivity({ id: 'c', sessionId, rawName: 'weird_tool', argumentsJson: '{}', at });
    expect(row.category).toBe('unknown');
    expect(row.label).toBe('weird_tool');
    expect(row.confidence).toBe('low');
  });

  it('builds approval / error / retry rows without leaking payloads', () => {
    const approval = approvalActivity(at, 'a1', sessionId, '/usr/local/bin/bash');
    expect(approval.category).toBe('approval');
    expect(approval.status).toBe('running');
    expect(approval.safeTarget).toBe('bash');

    const error = errorActivity(at, 'e1', sessionId, 'QUOTA');
    expect(error.label).toBe('QUOTA');
    expect(error.status).toBe('failed');

    const retry = retryActivity(at, 'r1', sessionId, 2);
    expect(retry.label).toContain('2');
    expect(retry.category).toBe('reasoning');
  });

  it('settles a row with a duration and keeps it immutable', () => {
    const row = toolActivity({ id: 'c', sessionId, rawName: 'grep', argumentsJson: '{}', at });
    const settled = settledActivity(row, 'success', at + 120);
    expect(settled.status).toBe('success');
    expect(settled.duration).toBe(120);
    expect(settled.finishedAt).toBe(at + 120);
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
      'command',
      'type',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(row)).not.toContain('rm -rf');
  });
});
