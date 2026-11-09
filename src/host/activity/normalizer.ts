/**
 * The Activity Normalizer — DSH payloads → the allow-listed Activity DTO.
 *
 * Every constructor here starts from a real event and keeps only fields the
 * browser is allowed to see: a family word, a redacted basename, a status, a
 * moment. Nothing else exists in the return type, so nothing else can leak.
 */
import {
  CATEGORY_LABEL,
  type OrbitActivity,
  type OrbitActivityStatus,
  type OrbitConfidence,
} from '../../shared/task-context-types';
import { classify, wantsTarget } from './classifier';
import {
  clipLabel,
  displayNameForTool,
  safeErrorLabel,
  targetFromArguments,
  type RedactedTarget,
} from './redactor';

export interface ToolCallInput {
  id: string;
  sessionId: string;
  rawName: string;
  argumentsJson: string;
  /** Epoch milliseconds when the call started. */
  at: number;
  turn?: number;
  step?: number;
}

function withTarget(base: OrbitActivity, target: RedactedTarget | undefined): OrbitActivity {
  if (target === undefined) return base;
  return { ...base, safeTarget: target.value, ...(target.redacted ? { redacted: true } : {}) };
}

/** Build the running row for one `tool/call`. */
export function toolActivity(input: ToolCallInput): OrbitActivity {
  const classification = classify({ name: input.rawName, argumentsJson: input.argumentsJson });
  const target = wantsTarget(classification.category, classification.fileKind)
    ? targetFromArguments(input.argumentsJson)
    : undefined;
  const toolName = clipLabel(input.rawName, 32);
  // The family word is the safe label; the raw name only survives when we could
  // not classify at all (it is the one thing that still tells the user something).
  const label = classification.category === 'unknown' && toolName !== ''
    ? toolName
    : CATEGORY_LABEL[classification.category];

  const base: OrbitActivity = {
    id: input.id,
    sessionId: input.sessionId,
    callId: input.id,
    category: classification.category,
    label,
    status: 'running',
    startedAt: input.at,
    source: 'tool',
    confidence: classification.confidence,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.step === undefined ? {} : { step: input.step }),
    ...(classification.fileKind === undefined ? {} : { fileKind: classification.fileKind }),
  };
  return withTarget(base, target);
}

/** Correlation detail that may accompany a non-tool row. */
export interface ActivityDetail {
  turn?: number;
  step?: number;
  /** The tool call this row is about, so a later `tool/call` can settle it. */
  callId?: string;
}

/**
 * Row for an approval ask; carries no tool arguments by construction.
 *
 * The tool name survives as a name (clipped, path-looking ones reduced to their
 * basename) — an approval that says only 「读取敏感配置文件」 tells the user
 * nothing about what they are being asked to allow.
 */
export function approvalActivity(
  at: number,
  id: string,
  sessionId: string,
  toolName?: string,
  detail?: ActivityDetail,
): OrbitActivity {
  const name = displayNameForTool(toolName);
  return {
    id,
    sessionId,
    category: 'approval',
    label: CATEGORY_LABEL.approval,
    status: 'running',
    startedAt: at,
    source: 'approval',
    confidence: 'high',
    ...(name === undefined ? {} : { safeTarget: name }),
    ...(detail?.callId === undefined ? {} : { callId: detail.callId }),
    ...(detail?.turn === undefined ? {} : { turn: detail.turn }),
    ...(detail?.step === undefined ? {} : { step: detail.step }),
  };
}

/**
 * Row for a `user-questions/request`.
 *
 * A question is the same *kind* of event as an approval — the Agent is blocked
 * on the human — so it uses the same family, but it must not borrow the copy:
 * 「等待你回答」 is a different thing to ask of someone than 「等待审批」.
 *
 * The question text itself is user-facing content and is never passed here; only
 * the tool name survives, and only as a clipped label rather than a path (a tool
 * name is not a location, so `redactPath` would mangle it).
 */
export function questionActivity(
  at: number,
  id: string,
  sessionId: string,
  toolName?: string,
  detail?: ActivityDetail,
): OrbitActivity {
  const toolLabel = displayNameForTool(toolName) ?? '';
  return {
    id,
    sessionId,
    category: 'approval',
    label: '等待你回答',
    status: 'running',
    startedAt: at,
    source: 'approval',
    confidence: 'high',
    ...(toolLabel === '' ? {} : { safeTarget: toolLabel }),
    ...(detail?.callId === undefined ? {} : { callId: detail.callId }),
    ...(detail?.turn === undefined ? {} : { turn: detail.turn }),
    ...(detail?.step === undefined ? {} : { step: detail.step }),
  };
}

/**
 * Row for an Agent-level failure. The DSH failure code is a short machine label
 * (`QUOTA`, `AUTH`, …) and is safe to show; messages are not forwarded.
 */
export function errorActivity(at: number, id: string, sessionId: string, code?: string): OrbitActivity {
  return {
    id,
    sessionId,
    category: 'unknown',
    label: safeErrorLabel(code),
    status: 'failed',
    startedAt: at,
    source: 'lifecycle',
    confidence: 'high',
  };
}

/** Row for a model retry; the retry count is the only detail that survives. */
export function retryActivity(at: number, id: string, sessionId: string, attempt: number): OrbitActivity {
  const label = Number.isFinite(attempt) && attempt > 0 ? `重试第 ${Math.floor(attempt)} 次` : '模型重试';
  return {
    id,
    sessionId,
    category: 'reasoning',
    label,
    status: 'running',
    startedAt: at,
    source: 'lifecycle',
    confidence: 'high',
  };
}

/** Row for a model-side phase (thinking / answering) observed from the stream. */
export function reasoningActivity(
  at: number,
  id: string,
  sessionId: string,
  kind: 'thinking' | 'responding',
  location?: { turn?: number; step?: number },
): OrbitActivity {
  return {
    id,
    sessionId,
    category: kind === 'thinking' ? 'reasoning' : 'response',
    label: kind === 'thinking' ? '模型正在分析请求' : '模型正在组织答复',
    status: 'running',
    startedAt: at,
    source: 'stream',
    confidence: 'medium',
    ...(location?.turn === undefined ? {} : { turn: location.turn }),
    ...(location?.step === undefined ? {} : { step: location.step }),
  };
}

/** Settle a row in place: a new object, so React sees the change. */
export function settledActivity(
  row: OrbitActivity,
  status: OrbitActivityStatus,
  at: number,
): OrbitActivity {
  const duration = Math.max(0, at - row.startedAt);
  return { ...row, status, finishedAt: at, duration };
}

/** Move an unsettled row to `unknown` when its result never arrived. */
export function abandonActivity(row: OrbitActivity, at: number): OrbitActivity {
  if (row.status !== 'running') return row;
  return { ...row, status: 'unknown', finishedAt: at, duration: Math.max(0, at - row.startedAt) };
}

/** Confidence of a settled row: a real tool result outranks a stream guess. */
export function confidenceOf(row: OrbitActivity): OrbitConfidence {
  if (row.status === 'success' || row.status === 'failed') return 'high';
  return row.confidence;
}
