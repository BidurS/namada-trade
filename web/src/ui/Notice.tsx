// Notice (system.md 8): left 3 px rule, 20 px icon, title 600, sub 13 px ink-2. Tones info,
// success, warning, danger replace the old hand-rolled boxes. On yellow: black rule, 6 % wash.
// The text describes what happened, never what to do.
import React from 'react';
import { Ico } from './ico';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
const ICON: Record<NoticeTone, string> = { info: 'info', success: 'check', warning: 'warn', danger: 'warn' };

export interface NoticeProps {
  tone?: NoticeTone;
  title: React.ReactNode;
  children?: React.ReactNode;
  /** One action under the text (a link or button). */
  action?: React.ReactNode;
  /** Announce politely when it appears (e.g. a quote that stopped answering). */
  live?: boolean;
  className?: string;
}

export function Notice({ tone = 'info', title, children, action, live, className = '' }: NoticeProps) {
  return (
    <div className={`notice ${className}`} data-tone={tone} role={live ? 'status' : undefined}>
      <Ico name={ICON[tone]} className="ico notice__i" />
      <div>
        <p className="notice__t">{title}</p>
        {children ? <div className="notice__s">{children}</div> : null}
        {action ? <div className="notice__a">{action}</div> : null}
      </div>
    </div>
  );
}

export default Notice;
