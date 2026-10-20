// The phone tab bar (system.md 3): six equal cells below 1024 px, fixed to the bottom with the
// safe-area inset, 20 px icon plus an 11 px label, a 2 px yellow rule on the active cell, and
// the Alerts count dot. Hidden from 1024 px, where the same six links sit in the header.
import { TABS, type TabId } from '../../../shared/routes';
import { Icon, type GridIconName } from '../ui/Icon';
import { AlertsCount } from './Header';
import { Link } from './Link';
import { useRoute } from './router';

export const TAB_ICON: Record<TabId, GridIconName> = {
  home: 'home',
  trade: 'trade',
  supply: 'supply',
  shielded: 'shielded',
  activity: 'activity',
  alerts: 'alerts',
};

export function TabBar() {
  const { route } = useRoute();
  const active = route?.tab ?? null;
  return (
    <nav className="tabbar ground-chrome" aria-label="Primary">
      <ul>
        {TABS.map((t) => (
          <li key={t.id}>
            <Link to={t.path} aria-current={active === t.id ? 'page' : undefined}>
              <span className="tabbar__i">
                <Icon name={TAB_ICON[t.id]} />
                {t.id === 'alerts' ? <AlertsCount /> : null}
              </span>
              <span>{t.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
