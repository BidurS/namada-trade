// The one place the kit touches the shell's Icon component (web/src/ui/Icon.tsx, owned by F1).
// If the shell's prop names change, only this file changes.
import React from 'react';
import { Icon } from './Icon';

export type IcoName = string;

/** A 24 px grid icon (`.ico`) or a 12 px flow glyph (`.gly`), always aria-hidden. */
export const Ico: React.FC<{ name: IcoName; className?: string }> = ({ name, className }) => (
  <Icon name={name as never} className={className} />
);
