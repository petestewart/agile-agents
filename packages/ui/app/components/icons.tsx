/**
 * T043: the tool row's icon set, lifted verbatim from the visual spec's
 * paths (`design/control-room-mockup.html`, the `.toolrow` buttons and the
 * Settings pop-out). Inline SVG, no dependency — `currentColor` throughout,
 * so every icon follows the button's own theme token in dark and light.
 *
 * Each icon is decorative: the accessible name lives on the wrapping
 * `<button>` (`aria-label` + `title`), so these are `aria-hidden`.
 */

interface IconProps {
  size?: number;
}

function Svg({ size = 15, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function RailCollapseIcon({ collapsed = false }: { collapsed?: boolean }): JSX.Element {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={collapsed ? 'M9 4v16M13 10l2 2-2 2' : 'M9 4v16M15 10l-2 2 2 2'} />
    </Svg>
  );
}

export function ChatIcon(): JSX.Element {
  return (
    <Svg size={16}>
      <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />
    </Svg>
  );
}

export function PopOutIcon(): JSX.Element {
  return (
    <Svg>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function MaximizeIcon({ on = false }: { on?: boolean }): JSX.Element {
  return (
    <Svg>
      <path
        d={
          on ? 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7' : 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'
        }
      />
    </Svg>
  );
}
