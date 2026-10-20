// Error boundaries for the parts of the shell that load on first use (the sheets, search, the header
// price's provenance sheet) and a last-resort one around the whole app.
//
// Why: after a deploy an open tab still runs the old bundle, and the old hashed chunks are gone from
// the server. A lazy import then rejects, and without a boundary above it React unmounts the root:
// a blank page. React.lazy also caches the rejected import, so opening the same part again fails the
// same way; reloading the page (which fetches the new version) is the real remedy, so every notice
// here offers it. Render errors inside a sheet are caught the same way.
import React, { useEffect, useId, useRef } from 'react';
import { Icon } from '../ui/Icon';

const reload = () => location.reload();

/** The small dialog shown in place of a part that did not load. Escape and Close call onClose. */
export function LoadFailed({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    const onCancel = (e: Event) => {
      e.preventDefault();
      cb.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
    };
  }, []);
  return (
    <dialog ref={ref} className="sheet ground-ink load-failed" aria-labelledby={tid}>
      <div className="sheet__in">
        <div>
          <div className="sheet__head">
            <h2 id={tid} className="sheet__t">This part did not load</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => cb.current()}>
              <Icon name="close" className="ico" />
            </button>
          </div>
          <p className="sheet__lead">A new version may have been deployed while the page was open. Reloading the page gets it.</p>
        </div>
        <div className="sheet__foot">
          <button type="button" className="btn btn--primary" onClick={reload}>
            Reload the page
          </button>
        </div>
      </div>
    </dialog>
  );
}

interface PartProps {
  children: React.ReactNode;
  /** Closes the part (closeSheet, closePalette); the boundary resets itself first. */
  onClose: () => void;
  /** A new value (another sheet, the palette closed) clears a failure. */
  resetKey: unknown;
}

/** Wraps one lazily loaded overlay: a failed import or render shows LoadFailed instead of blanking the app. */
export class PartBoundary extends React.Component<PartProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('overlay failed', err);
  }
  componentDidUpdate(prev: PartProps) {
    if (this.state.failed && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <LoadFailed
        onClose={() => {
          this.setState({ failed: false });
          this.props.onClose();
        }}
      />
    );
  }
}

/** The last resort around the providers and the shell: no failure leaves an empty page. */
export class AppBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('app failed', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="ground-ink app-failed">
        <div className="wrap oops" role="alert">
          <h1 className="h2">This page did not load.</h1>
          <p className="sub">A new version may have been deployed while the page was open, or a part of the page failed. Reloading the page usually fixes it.</p>
          <button type="button" onClick={reload}>Reload the page</button>
        </div>
      </main>
    );
  }
}
