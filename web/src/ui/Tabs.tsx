// Page tabs (system.md 8: "Transactions | Holders"): real links, 52 px high, the active one has
// a 2 px yellow underline (the only yellow underline besides desktop nav) and aria-current.
import React from 'react';
import { linkClick, useUiConfig } from './now';

export interface TabItem {
  label: React.ReactNode;
  href: string;
  current?: boolean;
}

export function Tabs({ items, label, className = '', children }: { items: TabItem[]; label: string; className?: string; children?: React.ReactNode }) {
  const cfg = useUiConfig();
  const nav = (
    <nav className={`utabs ${children ? '' : className}`} aria-label={label}>
      {items.map((t) => (
        <a key={t.href} href={t.href} aria-current={t.current ? 'page' : undefined} onClick={linkClick(cfg, t.href)}>
          {t.label}
        </a>
      ))}
    </nav>
  );
  if (!children) return nav;
  // with trailing controls (e.g. the Filter button): one bar with a hairline under it
  return (
    <div className={`utabs-bar ${className}`}>
      {nav}
      {children}
    </div>
  );
}

export default Tabs;
