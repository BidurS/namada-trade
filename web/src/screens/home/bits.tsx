// Small pieces the Home sections share: the "All activity →" link (a real <a href> that keeps
// ?at=), the path's step ring, and the plain line shown when a request did not answer.
import React from 'react';
import { Link } from '../../app/index';
import { Icon } from '../../ui/index';

/** A text link with a 2 px underline and a trailing icon, 44 px tall (system.md 8 "Link"). Keeps ?at=. */
export function MoreLink({ to, icon = 'arrow', children, className = '', keepAt = true }: { to: string; icon?: 'arrow' | 'rewind'; children: React.ReactNode; className?: string; keepAt?: boolean }) {
  return (
    <Link to={to} keepAt={keepAt} className={`link ${className}`}>
      <span>{children}</span>
      <Icon name={icon} className="ico ico--inline" />
    </Link>
  );
}

/** The ring on the path rail: an outline with a dot that scales in when the step is reached. */
export function StepRing() {
  return (
    <span className="step__ring" aria-hidden="true">
      <svg viewBox="0 0 28 28" focusable="false">
        <circle className="r0" cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle className="r1" cx="14" cy="14" r="6" fill="currentColor" />
      </svg>
    </span>
  );
}

/** "No data" for a whole panel: the dash ring and the reason, in view (never a stand-in figure). */
export function NoData({ children }: { children: React.ReactNode }) {
  return (
    <p className="home-none">
      <i className="dot" data-status="none" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A dimmed list's one sentence (system.md 8, SourceLine): the old dot and the reason. */
export function OldLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="old">
      <i className="dot" data-status="old" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
