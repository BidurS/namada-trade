// EmptyState (system.md 8): a dashed ring, one title ("Nothing crossed an alert size in 24
// hours."), one sentence (the threshold in dollars, derived), the last occurrence with a rewind
// link, the window in words (never under one hour). It says what would appear and what its
// absence means.
import React from 'react';
import { ArrowLink } from './Button';

export interface EmptyStateProps {
  title: React.ReactNode;
  /** The one sentence under the title. */
  children?: React.ReactNode;
  /** The last occurrence ("The last one: <Tag/> 2,999,716 NAM, 16 days ago."). */
  last?: React.ReactNode;
  /** The rewind link to the last occurrence (an ?at= href). */
  rewindHref?: string;
  rewindLabel?: string;
  className?: string;
}

export function EmptyState({ title, children, last, rewindHref, rewindLabel = 'Rewind to it', className = '' }: EmptyStateProps) {
  return (
    <div className={`empty ${className}`}>
      <svg className="empty__ring" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 5" />
      </svg>
      <div>
        <p className="empty__t">{title}</p>
        {children ? <div className="empty__s">{children}</div> : null}
        {last ? <div className="empty__last">{last}</div> : null}
        {rewindHref ? (
          <p className="empty__a">
            <ArrowLink href={rewindHref} icon="rewind">{rewindLabel}</ArrowLink>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default EmptyState;
