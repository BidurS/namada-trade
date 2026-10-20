// Measures an element in CSS px with ResizeObserver (charts draw at 1:1, never a scaled viewBox).
import { useLayoutEffect, useRef, useState } from 'react';

export function useSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => setSize((s) => (Math.abs(s.w - w) < 0.5 && Math.abs(s.h - h) < 0.5 ? s : { w, h }));
    const r = el.getBoundingClientRect();
    set(r.width, r.height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) set(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
