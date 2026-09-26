/**
 * T368 (design/cockpit-ui.md §1.7): the keyboard help (`?` when not
 * typing) and the `g` then letter jumps to a view (`g i` Needs me). It
 * lists only keys that work: the palette (⌘K), `n` (NewStream), `/`
 * (StreamTree), Esc (every Dialog, Menu and panel), the composer's Enter,
 * the arrows in menus, Knowledge and the tree.
 */

import { Fragment, useEffect, useState } from 'react';
import { modKeyLabel } from '../lib/palette';
import { type ShellView, isShortcut, useShell } from '../lib/shell';
import { Dialog, Kbd } from './ui';

const openers = new Set<() => void>();

/** Opens the keyboard help from anywhere (the command palette's action). */
export function openShortcuts(): void {
  for (const open of openers) open();
}

/** `g` then one of these letters opens the view. */
export const GO_KEYS: ReadonlyArray<{ key: string; view: ShellView; label: string }> = [
  { key: 'i', view: 'inbox', label: 'Needs me' },
  { key: 'd', view: 'director', label: 'Director' },
  { key: 'k', view: 'rules', label: 'Knowledge' },
  { key: 'r', view: 'running', label: 'Running' },
  { key: 'e', view: 'events', label: 'Events' },
  { key: 's', view: 'settings', label: 'Settings' },
];

/** How long after `g` the second key still counts. */
const GO_WINDOW_MS = 1500;

type Keys = ReadonlyArray<string | ReadonlyArray<string>>;

function sections(mod: string): ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<{ label: string; keys: Keys; sequence?: true }>;
}> {
  return [
    {
      title: 'General',
      rows: [
        { label: 'Search and run anything', keys: [[mod, 'K']] },
        { label: 'New node', keys: ['N'] },
        { label: 'Filter the node tree', keys: ['/'] },
        { label: 'Keyboard shortcuts', keys: ['?'] },
        { label: 'Close a dialog, menu or panel', keys: ['Esc'] },
      ],
    },
    {
      title: 'Go to',
      rows: GO_KEYS.map((go) => ({
        label: go.label,
        keys: ['G', go.key.toUpperCase()],
        sequence: true,
      })),
    },
    {
      title: 'Writing a message',
      rows: [
        { label: 'Send', keys: ['Enter'] },
        { label: 'New line', keys: [['Shift', 'Enter']] },
      ],
    },
    {
      title: 'Lists',
      rows: [
        { label: 'Move through menus, results and Knowledge', keys: ['↑', '↓'] },
        { label: 'Fold or unfold a node in the tree', keys: ['←', '→'] },
      ],
    },
  ];
}

function KeyCombo({ keys, sequence }: { keys: Keys; sequence?: true }): JSX.Element {
  return (
    <span className="cr-keys-combo">
      {keys.map((k, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keys are positional.
        <Fragment key={i}>
          {i > 0 && <span className="cr-keys-sep">{sequence ? 'then' : ''}</span>}
          {typeof k === 'string' ? <Kbd>{k}</Kbd> : k.map((part) => <Kbd key={part}>{part}</Kbd>)}
        </Fragment>
      ))}
    </span>
  );
}

export function Shortcuts(): JSX.Element | null {
  const { setView } = useShell();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = (): void => setOpen(true);
    openers.add(show);
    return () => {
      openers.delete(show);
    };
  }, []);

  useEffect(() => {
    let pendingG = 0;
    const onKey = (event: KeyboardEvent): void => {
      // Not over another dialog (its own keys win), and never while typing (isShortcut).
      if (document.querySelector('.cr-modal')) return;
      if (isShortcut(event, '?')) {
        event.preventDefault();
        pendingG = 0;
        setOpen(true);
        return;
      }
      if (pendingG > 0 && Date.now() - pendingG < GO_WINDOW_MS) {
        pendingG = 0;
        const go = GO_KEYS.find((g) => g.key === event.key.toLowerCase());
        if (go && isShortcut(event, event.key)) {
          event.preventDefault();
          setView(go.view);
        }
        return;
      }
      pendingG = isShortcut(event, 'g') ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  if (!open) return null;
  const mod = modKeyLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  return (
    <Dialog
      open
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      size="lg"
      testid="shortcuts"
    >
      <div className="cr-keys">
        {sections(mod).map((section) => (
          <section key={section.title} className="cr-keys-section">
            <h3>{section.title}</h3>
            <dl>
              {section.rows.map((row) => (
                <div key={row.label} className="cr-keys-row">
                  <dt>{row.label}</dt>
                  <dd>
                    <KeyCombo keys={row.keys} {...(row.sequence ? { sequence: true } : {})} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
