import type { ReactNode } from 'react';

function Icon({ children, filled = false }: { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SelectIcon = () => (
  <Icon>
    <path d="M3.5 2.5 12 6.6 8.4 8 7 11.8z" />
  </Icon>
);

export const FrameIcon = () => (
  <Icon>
    <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />
  </Icon>
);

export const RectIcon = () => (
  <Icon>
    <rect x="3" y="3" width="10" height="10" rx="1.2" />
  </Icon>
);

export const EllipseIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.3" />
  </Icon>
);

export const LineIcon = () => (
  <Icon>
    <path d="M3 13 13 3" />
  </Icon>
);

export const TextIcon = () => (
  <Icon>
    <path d="M3.5 4.5V3h9v1.5M8 3v10M6.2 13h3.6" />
  </Icon>
);

export const HandIcon = () => (
  <Icon>
    <path d="M5.6 8.2V4.3a1 1 0 0 1 2 0V7m0 .2V3.2a1 1 0 0 1 2 0V7m0 .2V4.4a1 1 0 0 1 2 0V10a4 4 0 0 1-4 4h-.5a3.6 3.6 0 0 1-3-1.6L2.9 10a1 1 0 0 1 1.6-1.2l1.1 1.2" />
  </Icon>
);

export const CommentIcon = () => (
  <Icon>
    <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11A1.5 1.5 0 0 1 2.5 9.5z" />
  </Icon>
);

export const UndoIcon = () => (
  <Icon>
    <path d="M3.5 6.5h6a3 3 0 0 1 0 6H6.5M3.5 6.5 6 4m-2.5 2.5L6 9" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="M12.5 6.5h-6a3 3 0 0 0 0 6h3M12.5 6.5 10 4m2.5 2.5L10 9" />
  </Icon>
);

export const PanelLeftIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11v9h-11zM6.2 3.5v9" />
  </Icon>
);

export const PanelRightIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11v9h-11zM9.8 3.5v9" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon filled>
    <path d="M5.2 3.6 12 8l-6.8 4.4z" />
  </Icon>
);
