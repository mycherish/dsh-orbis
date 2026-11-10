/**
 * Release contract.
 *
 * Every other test file exercises behaviour. This one exercises the *package*:
 * the manifest, the two committed artifacts and the loader envelope have to
 * agree with each other, because none of them is checked by `tsc` and every one
 * of them can silently break a published install.
 *
 * A stale `client.js` or a banner that still says the previous version is not a
 * bug a user reports — they just get the old plugin. So the assertions here are
 * deliberately about cross-file agreement rather than about any single file's
 * contents.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HUD_KEY,
  LEGACY_SETTINGS_KEY,
  POSITION_KEY,
  RENAMED_KEYS,
  SETTINGS_KEY,
} from '../src/client/store';
import { EVENTS_ROUTE, STATE_ROUTE } from '../src/shared/protocol';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  engines?: { node?: string; dsh?: string };
  private?: boolean;
  license?: string;
  exports: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string };
  dsh: {
    bundle: { patch: string };
    client: { platform: string; inject: string[] };
  };
};

/** Expand the one glob shape `files` actually uses (`locale/*.json`). */
function expandFilesEntry(entry: string): string[] {
  if (!entry.includes('*')) return [entry];
  const dir = entry.slice(0, entry.indexOf('/'));
  const suffix = entry.slice(entry.indexOf('*') + 1);
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(suffix))
    .map((name) => `${dir}/${name}`);
}

describe('manifest', () => {
  it('is publishable', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.license).toBe('MIT');
    expect(existsSync(join(root, 'LICENSE'))).toBe(true);
    expect(existsSync(join(root, 'THIRD-PARTY-NOTICES.md'))).toBe(true);
  });

  it('declares the entry points the loader asks for', () => {
    // `./client` is mandatory for the browser half; `./package.json` is what
    // makes the manifest readable from inside an installed profile.
    for (const key of ['.', './client', './package.json']) {
      const target = pkg.exports[key];
      expect(target, `exports["${key}"]`).toBeTypeOf('string');
      expect(existsSync(join(root, target!)), `exports["${key}"] -> ${target}`).toBe(true);
    }
  });

  it('ships every file it lists, and only files that exist', () => {
    const shipped = pkg.files.flatMap(expandFilesEntry);
    expect(shipped).toEqual(
      expect.arrayContaining(['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']),
    );
    for (const file of shipped) {
      expect(existsSync(join(root, file)), `${file} is listed in files but missing`).toBe(true);
    }
    expect(shipped.some((file) => file.endsWith('.json') && file.startsWith('locale/'))).toBe(true);
  });

  it('asks only for client packages that provide the services the browser half injects', () => {
    expect(pkg.dsh.client.platform).toBe('web');
    // `ctx.locale` and `ctx.slots` are the two services src/client/index.tsx
    // declares; listing the packages that own them keeps activation ordered
    // without pinning the whole ui shell.
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-locale');
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-renderer');
    expect(pkg.dsh.client.inject).toHaveLength(2);
  });
});

describe('host floor', () => {
  it('declares the floor whose carrier supports resource routes', () => {
    /*
     * Both routes are `{ resource }` routes. `WebServer.serveResource` — the branch
     * that builds a Fetch Request, takes the Response, and aborts it when the socket
     * closes — first shipped in 0.2.2-rc.1; 0.2.1-rc.x dispatches only
     * `handler(req, res)` and would call a method these routes do not have. This
     * assertion exists because the first published manifest claimed
     * ">=0.2.0-rc.1", i.e. it advertised two host versions on which the routes
     * cannot answer at all.
     */
    expect(pkg.engines?.dsh).toBe('>=0.2.2-rc.1 <0.3.0-0');
  });
});

describe('README', () => {
  it('only names source paths that exist', () => {
    /*
     * The source table drifted into listing `src/host/quiet.ts`,
     * `categories.ts` and `normalize.ts` — three files that had been renamed or
     * never existed — and it shipped that way to the npm page. A reader cannot
     * check the README, which is exactly why this does.
     */
    const readme = read('README.md');
    const mentioned = new Set(
      [...readme.matchAll(/`(src\/[A-Za-z0-9._/-]+)`/g)].map((match) => match[1] ?? ''),
    );
    expect(mentioned.size).toBeGreaterThan(10);
    for (const path of mentioned) {
      const target = path.endsWith('/') ? path.slice(0, -1) : path;
      expect(existsSync(join(root, target)), `${path} is named in README but does not exist`).toBe(
        true,
      );
    }
  });
});

describe('bundle patch', () => {
  const patch = read(pkg.dsh.bundle.patch);

  it('inserts the row that loads this package', () => {
    expect(patch).toMatch(/^- insert:/m);
    const rowName = /^\s*name:\s*'([^']+)'/m.exec(patch)?.[1];
    expect(rowName).toBe(pkg.name);
    const rowId = /^\s*-\s*id:\s*(\S+)/m.exec(patch)?.[1];
    expect(rowId, 'the inserted row needs an id').toBeTypeOf('string');
    expect(rowId).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe('committed artifacts', () => {
  const client = read('client.js');
  const host = read('index.js');

  it('carry the current version, so a bump cannot ship a stale build', () => {
    expect(host).toContain(`/* ${pkg.name} ${pkg.version} — host half.`);
    expect(client).toContain(`/* ${pkg.name} ${pkg.version} — browser half.`);
  });

  it('register the browser half under the package name', () => {
    const loads = client.match(/__ModuleLoader__\.load\(/g) ?? [];
    expect(loads).toHaveLength(1);
    const id = /id:\s*("([^"]+)"|'([^']+)')/.exec(client);
    expect(id?.[2] ?? id?.[3]).toBe(pkg.name);
  });

  it('register the routes the shared contract names', () => {
    for (const route of [STATE_ROUTE, EVENTS_ROUTE]) {
      expect(host, `${route} is not registered by the build`).toContain(route);
    }
  });

  it('keep the MIT notices for three.js and zustand', () => {
    expect(client).toContain('three.js — MIT');
    expect(client).toContain('zustand  — MIT');
  });

  it('expose no trace of the pre-rename brand except the legacy storage keys', () => {
    // The storage keys are the one place the old namespace must survive: they
    // are how a user who installed as `dsh-neural-orbit` keeps their switches.
    const legacy = new Set(Object.values(RENAMED_KEYS));
    const found = new Set(client.match(/neural[-_ ]?orbit[a-z0-9.]*/gi) ?? []);
    expect([...found].sort()).toEqual([...legacy].sort());
    expect(host).not.toMatch(/neural[-_ ]?orbit/i);
  });
});

describe('renamed keys', () => {
  it('map every namespaced key onto its old spelling', () => {
    for (const key of [SETTINGS_KEY, LEGACY_SETTINGS_KEY, POSITION_KEY, HUD_KEY]) {
      expect(RENAMED_KEYS[key], `${key} has no pre-rename twin`).toBeTypeOf('string');
      expect(RENAMED_KEYS[key] ?? '').toMatch(/^neural-orbit\./);
      expect(key).toMatch(/^orbis\./);
    }
    expect(Object.keys(RENAMED_KEYS)).toHaveLength(4);
  });
});
