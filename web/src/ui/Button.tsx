// Button and ArrowLink (system.md 8). Primary: one per view, a pill of the ground's
// high-contrast fill. Secondary: transparent with a 2 px line-strong border, inverts on hover.
// Destructive: outlined in the sell hue; delete and sign-out-everywhere only.
// With `href` the button is a real <a> (links are links: Ctrl/Cmd-click and middle-click work).
import React from 'react';
import { Ico } from './ico';
import { linkClick, useUiConfig } from './now';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'destructive';
  /** Render as a link to this address. */
  href?: string;
  /** Trailing arrow that slides 3 px on hover. */
  arrow?: boolean;
  /** Leading icon name. */
  icon?: string;
  size?: 'md' | 'sm';
  block?: boolean;
  /** Shows a busy state; the label stays (no waiting word). */
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
  'aria-haspopup'?: 'dialog' | 'menu' | 'true';
  'aria-expanded'?: boolean;
}

export function Button({ variant = 'secondary', href, arrow, icon, size = 'md', block, busy, disabled, type = 'button', onClick, className = '', children, ...aria }: ButtonProps) {
  const cfg = useUiConfig();
  const cls = `btn btn--${variant}${size === 'sm' ? ' btn--sm' : ''}${block ? ' btn--block' : ''} ${className}`;
  const inner = (
    <>
      {icon ? <Ico name={icon} className="ico ico--btn" /> : null}
      {children}
      {arrow ? <Ico name="arrow" className="ico ico--btn" /> : null}
    </>
  );
  if (href && !disabled) {
    const nav = linkClick(cfg, href);
    return (
      <a
        className={cls}
        href={href}
        onClick={(e) => {
          onClick?.(e);
          nav(e);
        }}
        aria-busy={busy || undefined}
        {...aria}
      >
        {inner}
      </a>
    );
  }
  return (
    <button type={type} className={cls} disabled={disabled} aria-busy={busy || undefined} onClick={onClick} {...aria}>
      {inner}
    </button>
  );
}

/** A text link with a 2 px underline, 44 px tall, optional trailing icon ("All activity →"). */
export function ArrowLink({ href, icon = 'arrow', children, className = '', onClick }: { href: string; icon?: string | null; children: React.ReactNode; className?: string; onClick?: () => void }) {
  const cfg = useUiConfig();
  return (
    <a className={`link ${className}`} href={href} onClick={linkClick(cfg, href, onClick)}>
      <span>{children}</span>
      {icon ? <Ico name={icon} className="ico ico--inline" /> : null}
    </a>
  );
}

/** A 44 px round icon button with an accessible name (e.g. Close). */
export function IconButton({ icon, label, onClick, className = '' }: { icon: string; label: string; onClick?: () => void; className?: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} onClick={onClick}>
      <Ico name={icon} className="ico" />
    </button>
  );
}

export default Button;
