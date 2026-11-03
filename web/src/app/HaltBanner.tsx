// The halt bar: while the Namada network is halted (shared/halt.ts HALT.on), every page says so under the header,
// in the Namada team's public words with their source, and what that means here. It has no button and no close: it
// stays until a release turns HALT.on off.
import { HALT } from '../../../shared/halt';

export function HaltBanner() {
  if (!HALT.on) return null;
  return (
    <section className="upd upd--halt" aria-label="Namada network status">
      <div className="upd__in">
        <p>
          <strong>{HALT.title}.</strong> {HALT.said} <span className="upd__src">({HALT.source})</span> {HALT.here}
        </p>
      </div>
    </section>
  );
}
