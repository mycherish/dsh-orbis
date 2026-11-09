import { describe, expect, it } from 'vitest';
import { classify, fileKindOfName, ALL_CATEGORIES } from '../src/host/activity/classifier';
import {
  isSensitiveName,
  redactInlinePaths,
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
    expect(targetFromArguments('{"path":"src/host/hub.ts"}')?.value).toBe('hub.ts');
    expect(targetFromArguments('{"other":1}')).toBeUndefined();
    expect(targetFromArguments('not json at all')).toBeUndefined();
    expect(targetFromArguments('[]')).toBeUndefined();
  });

  /*
   * A search pattern is what the user is *looking for*, not where it lives.
   * `grep`/`glob` make `path` optional, so the ordinary call carries the pattern
   * alone — forwarding it published secrets, tokens and internal hostnames to the
   * browser. This used to be asserted as expected behaviour (`'*.ts'`); the
   * assertion is now inverted on purpose.
   */
  it('never turns a search pattern into a display target', () => {
    expect(targetFromArguments('{"pattern":"**/*.ts"}')).toBeUndefined();
    expect(targetFromArguments('{"glob":"*.key"}')).toBeUndefined();
    expect(targetFromArguments('{"name":"id_rsa"}')).toBeUndefined();
  });

  it('keeps the real path when a search also names one', () => {
    expect(targetFromArguments('{"pattern":"AKIA[0-9A-Z]{16}","path":"src"}')?.value).toBe('src');
  });

  it('whitelists error codes only', () => {
    expect(safeErrorLabel('QUOTA')).toBe('QUOTA');
    expect(safeErrorLabel('upstream said: boom')).toBe('agent-error');
    expect(safeErrorLabel(undefined)).toBe('agent-error');
  });

  /*
   * Plan lines and Session titles are free prose, so they never passed through the
   * structured path above — the same guarantee has to be enforced on the text.
   */
  it('collapses absolute paths inside prose to a bare name', () => {
    expect(redactInlinePaths('cat /Users/alice/secret/plan.md then stop')).toBe('cat plan.md then stop');
    expect(redactInlinePaths('编辑 ~/www/app/src/hub.ts 即可')).toBe('编辑 hub.ts 即可');
    expect(redactInlinePaths('open C:\\Users\\bob\\notes.txt')).toBe('open notes.txt');
  });

  it('replaces a secret-bearing path inside prose with the placeholder', () => {
    const text = redactInlinePaths('cat /Users/alice/.ssh/id_rsa and paste it');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('id_rsa');
    expect(text).toContain(SENSITIVE_TARGET_LABEL);
  });

  it('leaves prose alone when there is no absolute path in it', () => {
    expect(redactInlinePaths('修复重复悬浮球')).toBe('修复重复悬浮球');
    expect(redactInlinePaths('支持读/写两种模式')).toBe('支持读/写两种模式');
    expect(redactInlinePaths('and/or')).toBe('and/or');
    expect(redactInlinePaths('run pnpm test')).toBe('run pnpm test');
    expect(redactInlinePaths('')).toBe('');
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

  /*
   * An approval row must say *which* tool is asking. Sending the tool name through
   * the path redactor turned `mcp__vault__read_credential` into
   * 「读取敏感配置文件」 — truthfully boring, and useless for deciding anything.
   */
  it('shows a tool name as a name, and only treats path-shaped ones as paths', () => {
    expect(approvalActivity(at, 'a1', sessionId, 'mcp__vault__read_credential').safeTarget)
      .toBe('mcp__vault__read_credential');
    expect(approvalActivity(at, 'a2', sessionId, 'bash').safeTarget).toBe('bash');
    // A name that really is a path still collapses to its basename.
    expect(approvalActivity(at, 'a3', sessionId, '/usr/local/bin/bash').safeTarget).toBe('bash');
    expect(approvalActivity(at, 'a4', sessionId).safeTarget).toBeUndefined();
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

  /*
   * The key-name sweep above cannot catch a leak that rides inside a *value*, so
   * the row's whole serialized form is scanned for the actual secrets. This is the
   * check that would have failed before the `pattern` key was removed.
   */
  it('the serialized DTO carries no search term, command or path fragment', () => {
    const cases = [
      { rawName: 'grep', argumentsJson: '{"pattern":"AKIA[0-9A-Z]{16}"}', secret: 'AKIA' },
      { rawName: 'grep', argumentsJson: '{"pattern":"password = \\"hunter2\\""}', secret: 'hunter2' },
      { rawName: 'glob', argumentsJson: '{"pattern":"**/*.pem"}', secret: 'pem' },
      { rawName: 'bash', argumentsJson: '{"command":"curl -H \\"X-Token: abc123\\" x"}', secret: 'abc123' },
      { rawName: 'read', argumentsJson: '{"file_path":"/Users/alice/.ssh/id_rsa"}', secret: 'alice' },
    ];
    for (const { rawName, argumentsJson, secret } of cases) {
      const json = JSON.stringify(toolActivity({ id: 'c', sessionId, rawName, argumentsJson, at }));
      expect(json).not.toContain(secret);
    }
    // The read row still says *something* useful: the family and the fact that the
    // name was withheld — never the name itself.
    const sensitive = toolActivity({
      id: 'c',
      sessionId,
      rawName: 'read',
      argumentsJson: '{"file_path":"/Users/alice/.ssh/id_rsa"}',
      at,
    });
    expect(sensitive.category).toBe('file_read');
    expect(sensitive.safeTarget).toBe(SENSITIVE_TARGET_LABEL);
  });
});
