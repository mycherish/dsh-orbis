/**
 * The always-on HUD module: the pure snapshot → copy/tone/progress rules and the
 * card that renders them. The shell mounts `ProgressCard`; nothing here owns a
 * transport, a timer or a WebGL context.
 */
export { ProgressCard, type ProgressCardProps } from './ProgressCard';
export {
  HUD_STATE_TITLE,
  formatSilence,
  hudCardMode,
  hudDetail,
  hudDodgeOffset,
  hudProgress,
  hudTitle,
  hudTone,
  isActiveState,
  isSettledState,
  type HudCardMode,
  type HudTone,
} from './progress';
