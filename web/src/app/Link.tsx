// <Link>: a real <a href> that navigates client-side on a plain left click (seo-requirements
// Must 2). Ctrl/Cmd-click, Shift-click, middle click and "open in new tab" keep working because
// the href is a real URL. The current ?at= is carried in the href, so a copied link opens the
// same rewound moment.
import React, { forwardRef } from 'react';
import { hrefFor, isModifiedClick, navigate, useLocation } from './router';

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** An app path ("/trade", "/supply?at=…"). */
  to: string;
  /** replaceState instead of pushState. */
  replace?: boolean;
  /** Carry the current ?at= (default true). Pass false for "Back to now" style links. */
  keepAt?: boolean;
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, replace, keepAt = true, onClick, target, ...rest }, ref) {
  useLocation(); // re-render when ?at= changes so the href stays true
  const href = hrefFor(to, keepAt);
  return (
    <a
      ref={ref}
      href={href}
      target={target}
      {...(keepAt ? {} : { 'data-drop-at': '' })}
      onClick={(e) => {
        onClick?.(e);
        if (isModifiedClick(e) || (target && target !== '_self')) return;
        e.preventDefault();
        navigate(to, { replace, keepAt });
      }}
      {...rest}
    />
  );
});
