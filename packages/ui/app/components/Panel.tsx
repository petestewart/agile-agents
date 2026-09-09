import { type PropsWithChildren, useState } from 'react';

/**
 * Collapsible panel shell — every "hideable" §17 panel (Team / Board / Feed
 * / Oracle) is one of these. Starts collapsed except when `defaultOpen` is
 * set, so the default view stays calm (design §17 "Layout direction").
 */
export function Panel({
  title,
  count,
  defaultOpen = false,
  children,
}: PropsWithChildren<{ title: string; count?: number; defaultOpen?: boolean }>) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="cr-panel">
      <div
        className="cr-panel-header"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((v) => !v)}
      >
        <span>{title}</span>
        {count !== undefined && <span className="count">({count})</span>}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="cr-panel-body">{children}</div>}
    </section>
  );
}
