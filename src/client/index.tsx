/**
 * Caelum Orbis — browser half entry.
 *
 * Registers a single `shell.overlay` entry that owns both the floating orb and
 * the workspace panel. The overlay is the narrowest slot that can hold a
 * frame-wide floating object, so the plugin never touches the app root, never
 * renders inside another plugin's area, and disappears cleanly on unload.
 */
import * as React from 'react';
import { OrbitLayer, type OrbitLayerProps } from './layer';

const NS = 'orbis';
const PANEL_ID = 'orbis';

/** Host services this half needs; both are part of the shipped web profile. */
export const inject = ['slots', 'locale'];

interface ClientContextLike {
  effect(callback: () => (() => void) | void, label?: string): () => void;
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  };
  slots: {
    inject(key: string, callback: () => () => void): () => void;
    register(
      options: {
        name: string;
        id: string;
        order?: number;
        locale?: string;
      },
      component: (props: OrbitLayerProps) => React.ReactElement,
    ): () => void;
  };
}

const zh = {
  'launcher.label': 'Caelum Orbis',
  'launcher.tools': '工具',
  'launcher.hide': '隐藏悬浮球',
  'launcher.show': '显示 Caelum Orbis',
  'state.idle': '待机',
  'state.thinking': '思考中',
  'state.executing': '执行中',
  'state.waiting': '等待确认',
  'state.error': '出错',
  'state.completed': '已完成',
};

const en = {
  'launcher.label': 'Caelum Orbis',
  'launcher.tools': 'tools',
  'launcher.hide': 'Hide orb',
  'launcher.show': 'Show Caelum Orbis',
  'state.idle': 'Idle',
  'state.thinking': 'Thinking',
  'state.executing': 'Executing',
  'state.waiting': 'Waiting',
  'state.error': 'Error',
  'state.completed': 'Completed',
};

export function apply(ctx: ClientContextLike): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'orbis: dictionaries',
  );
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: PANEL_ID,
        // Above the conversation chrome, below transient dialogs.
        order: 120,
        locale: NS,
      },
      OrbitLayer,
    ),
  );
}
