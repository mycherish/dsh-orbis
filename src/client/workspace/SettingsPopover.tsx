/**
 * The in-panel settings popover (spec §2.6).
 *
 * It lives inside the dialog — never a portal — and every control is a native
 * radio or a `role="switch"` button, so the whole sheet is reachable and
 * operable from the keyboard without a hand-written focus trap.
 */
import * as React from 'react';
import type { OrbitDisplayMode, OrbitSettings, ParticleDensity } from '../contracts';
import { LABELS } from './labels';

export interface SettingsPopoverProps {
  settings: OrbitSettings;
  onChange: (patch: Partial<OrbitSettings>) => void;
}

function asDensity(value: string): ParticleDensity {
  if (value === 'low') return 'low';
  if (value === 'high') return 'high';
  return 'medium';
}

function asDisplayMode(value: string): OrbitDisplayMode {
  if (value === 'compact') return 'compact';
  if (value === 'orb') return 'orb';
  return 'auto';
}

function asReduceMotion(value: string): OrbitSettings['reduceMotion'] {
  if (value === 'on') return 'on';
  if (value === 'off') return 'off';
  return 'system';
}

const DENSITIES: readonly ParticleDensity[] = ['low', 'medium', 'high'];

export function SettingsPopover({ settings, onChange }: SettingsPopoverProps): React.ReactElement {
  return (
    <div
      className="no-settings"
      id="no-orbit-settings"
      role="group"
      aria-label={LABELS.panel.settingsAria}
    >
      <div className="no-settings-head">
        <span className="no-settings-title">{LABELS.panel.settingsTitle}</span>
        <span className="no-settings-hint">{LABELS.panel.settingsHint}</span>
      </div>

      <SettingRow
        label={LABELS.settings.showRecentActivity.label}
        hint={LABELS.settings.showRecentActivity.hint}
      >
        <Switch
          checked={settings.showRecentActivity}
          label={LABELS.settings.showRecentActivity.label}
          onChange={(next) => onChange({ showRecentActivity: next })}
        />
      </SettingRow>

      <SettingRow
        label={LABELS.settings.showSilenceAlert.label}
        hint={LABELS.settings.showSilenceAlert.hint}
      >
        <Switch
          checked={settings.showSilenceAlert}
          label={LABELS.settings.showSilenceAlert.label}
          onChange={(next) => onChange({ showSilenceAlert: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.showWorkspace.label} hint={LABELS.settings.showWorkspace.hint}>
        <Switch
          checked={settings.showWorkspace}
          label={LABELS.settings.showWorkspace.label}
          onChange={(next) => onChange({ showWorkspace: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.animate.label} hint={LABELS.settings.animate.hint}>
        <Switch
          checked={settings.animate}
          label={LABELS.settings.animate.label}
          onChange={(next) => onChange({ animate: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.enabled.label} hint={LABELS.settings.enabled.hint}>
        <Switch
          checked={settings.enabled}
          label={LABELS.settings.enabled.label}
          onChange={(next) => onChange({ enabled: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.displayMode.label} hint={LABELS.settings.displayMode.hint}>
        <Segmented
          group="no-display-mode"
          label={LABELS.settings.displayMode.label}
          value={settings.displayMode}
          options={[
            { value: 'auto', label: LABELS.settings.displayMode.options.auto },
            { value: 'compact', label: LABELS.settings.displayMode.options.compact },
            { value: 'orb', label: LABELS.settings.displayMode.options.orb },
          ]}
          onChange={(next) => onChange({ displayMode: asDisplayMode(next) })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.showHud.label} hint={LABELS.settings.showHud.hint}>
        <Switch
          checked={settings.showHud}
          label={LABELS.settings.showHud.label}
          onChange={(next) => onChange({ showHud: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.showActivity.label} hint={LABELS.settings.showActivity.hint}>
        <Switch
          checked={settings.showActivity}
          label={LABELS.settings.showActivity.label}
          onChange={(next) => onChange({ showActivity: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.fps.label} hint={LABELS.settings.fps.hint}>
        <Segmented
          group="no-fps"
          label={LABELS.settings.fps.label}
          value={String(settings.fps)}
          options={[
            { value: '30', label: LABELS.settings.fps.options['30'] },
            { value: '60', label: LABELS.settings.fps.options['60'] },
          ]}
          onChange={(next) => onChange({ fps: next === '60' ? 60 : 30 })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.particles.label} hint={LABELS.settings.particles.hint}>
        <Segmented
          group="no-particles"
          label={LABELS.settings.particles.label}
          value={settings.particles}
          options={DENSITIES.map((density) => ({
            value: density,
            label: LABELS.settings.particles.options[density],
          }))}
          onChange={(next) => onChange({ particles: asDensity(next) })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.rings.label} hint={LABELS.settings.rings.hint}>
        <Switch
          checked={settings.rings}
          label={LABELS.settings.rings.label}
          onChange={(next) => onChange({ rings: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.glow.label} hint={LABELS.settings.glow.hint}>
        <Switch
          checked={settings.glow}
          label={LABELS.settings.glow.label}
          onChange={(next) => onChange({ glow: next })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.reduceMotion.label} hint={LABELS.settings.reduceMotion.hint}>
        <Segmented
          group="no-reduce-motion"
          label={LABELS.settings.reduceMotion.label}
          value={settings.reduceMotion}
          options={[
            { value: 'system', label: LABELS.settings.reduceMotion.options.system },
            { value: 'on', label: LABELS.settings.reduceMotion.options.on },
            { value: 'off', label: LABELS.settings.reduceMotion.options.off },
          ]}
          onChange={(next) => onChange({ reduceMotion: asReduceMotion(next) })}
        />
      </SettingRow>

      <SettingRow label={LABELS.settings.pauseWhenHidden.label} hint={LABELS.settings.pauseWhenHidden.hint}>
        <Switch
          checked={settings.pauseWhenHidden}
          label={LABELS.settings.pauseWhenHidden.label}
          onChange={(next) => onChange({ pauseWhenHidden: next })}
        />
      </SettingRow>
    </div>
  );
}

interface SettingRowProps {
  label: string;
  hint: string;
  children: React.ReactNode;
}

function SettingRow({ label, hint, children }: SettingRowProps): React.ReactElement {
  return (
    <div className="no-set-row">
      <span className="no-set-copy">
        <span className="no-set-label">{label}</span>
        <span className="no-set-hint">{hint}</span>
      </span>
      <span className="no-set-control">{children}</span>
    </div>
  );
}

interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedProps {
  /** Radio group name — unique per control, shared by its options. */
  group: string;
  /** Human label announced for the whole radio group. */
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  onChange: (next: string) => void;
}

function Segmented({ group, label, value, options, onChange }: SegmentedProps): React.ReactElement {
  return (
    <span className="no-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label className="no-seg-item" key={option.value}>
            <input
              className="no-seg-input"
              type="radio"
              name={group}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
            />
            <span className="no-seg-label">{option.label}</span>
          </label>
        );
      })}
    </span>
  );
}

interface SwitchProps {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}

function Switch({ checked, label, onChange }: SwitchProps): React.ReactElement {
  return (
    <button
      type="button"
      className="no-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}
