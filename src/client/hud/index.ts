/**
 * The always-on HUD module: the pure snapshot → copy / colour / clock rules and
 * the panel that renders them.
 *
 * The shell (layer.tsx) mounts `NeuralOrbitHUD` and hands it the ball canvas;
 * nothing in here owns a transport, a settings store or a WebGL renderer.
 */
export { NeuralOrbitHUD, type NeuralOrbitHUDProps } from './NeuralOrbitHUD';
export { TaskHeader, type TaskHeaderProps } from './TaskHeader';
export { TaskSummary, type TaskSummaryProps } from './TaskSummary';
export { ActivityTimeline, type ActivityTimelineProps } from './ActivityTimeline';
export { CurrentStatus, type CurrentStatusProps } from './CurrentStatus';
export { RuntimeInfo, type RuntimeInfoProps } from './RuntimeInfo';
export { HUD_LAYOUT, buildHudStyles, cssVars } from './styles';
export {
  ACTIVITY_ICON,
  ACTIVITY_STATUS_LABEL,
  HUD_STATUS_CHIP,
  RUNTIME_MODE_LABEL,
  STATUS_SENTENCE,
  activityColor,
  activityIcon,
  activityStatusLabel,
  activityText,
  currentStatusText,
  footerStats,
  formatClock,
  formatElapsed,
  hudActivityRows,
  hudCardMode,
  hudChipText,
  hudStatusChip,
  hudTone,
  isActiveState,
  isSettledState,
  nextStepLabel,
  phaseTextOf,
  runtimePills,
  shouldShowSilence,
  statusSentence,
  taskElapsedMs,
  taskTitleOf,
  type HudCardMode,
  type HudTone,
} from './progress';
