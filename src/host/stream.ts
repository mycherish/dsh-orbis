/**
 * Transient assistant-stream folding.
 *
 * DSH emits `agent/assistant-stream` frames while a model attempt is running.
 * The payload carries the actual deltas (`text`, and `argumentsDelta`), and
 * this module deliberately reads **only the type tags**: what matters for a
 * progress readout is *which phase* the model is in, never what it wrote.
 *
 * Reading `chunk.type` and nothing else is the whole security model here —
 * there is no code path that can copy `chunk.text` anywhere.
 */
import type { StreamPhase } from './state-machine';

export type StreamSignalKind =
  'attempt-start' | 'reasoning' | 'text' | 'tool-call' | 'finish' | 'attempt-end';

export interface StreamSignal {
  kind: StreamSignalKind;
  /** Durable Turn/Step the attempt belongs to, when the frame carried them. */
  turn?: number;
  step?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Map one `StreamChunk.type` to a signal, ignoring every content field. */
function signalOfChunk(type: unknown): StreamSignalKind | undefined {
  switch (type) {
    case 'reasoning-delta':
    case 'block-start':
      // `block-start` names the block type; a reasoning block means thinking.
      return type === 'reasoning-delta' ? 'reasoning' : undefined;
    case 'text-delta':
      return 'text';
    case 'tool-call-delta':
      return 'tool-call';
    case 'finish':
      return 'finish';
    default:
      return undefined;
  }
}

/**
 * Fold one `frame` from `agent/assistant-stream` into a phase signal, or
 * `undefined` when the frame says nothing about progress (`usage`, `block-end`,
 * malformed input).
 */
export function streamSignalOf(frame: unknown): StreamSignal | undefined {
  const record = asRecord(frame);
  if (record === undefined) return undefined;
  const type = record.type;
  const turn = asNumber(record.turn);
  const step = asNumber(record.step);

  if (type === 'start') return { kind: 'attempt-start', turn, step };
  if (type === 'end') return { kind: 'attempt-end', turn, step };
  if (type !== 'chunk') return undefined;

  const chunk = asRecord(record.chunk);
  if (chunk === undefined) return undefined;
  const kind = signalOfChunk(chunk.type);
  if (kind === undefined) return undefined;
  return { kind, turn, step };
}

/** The machine phase a signal implies; `undefined` means "no phase change". */
export function phaseOfSignal(signal: StreamSignal): StreamPhase | undefined {
  switch (signal.kind) {
    case 'attempt-start':
      return 'thinking';
    case 'reasoning':
      return 'thinking';
    case 'tool-call':
      return 'preparing';
    case 'text':
      return 'responding';
    default:
      return undefined;
  }
}
