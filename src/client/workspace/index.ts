/**
 * Public entry of the Workspace panel.
 *
 * The shell imports `WorkspaceView`; everything else in this directory is an
 * implementation detail. Keeping the exported component in a `.ts` entry (the
 * JSX lives in `WorkspacePanel.tsx`) means the module can be type-checked and
 * imported exactly as the plugin contract describes.
 */
import * as React from 'react';
import type { WorkspaceViewProps } from '../contracts';
import { WorkspacePanel } from './WorkspacePanel';

export function WorkspaceView(props: WorkspaceViewProps): React.ReactElement {
  return React.createElement(WorkspacePanel, props);
}
