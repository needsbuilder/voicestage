/** Small inline icons. All are decorative; the control that holds one carries the label. */
import type { SVGProps } from 'react';

function Icon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props} />;
}

export const MicIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
);
export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const PlayIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.7L9.500 4.600A1 1 0 0 0 8 5.500z" />
  </Icon>
);
export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);
export const NextIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M6 5l8 7-8 7zM18 5v14" />
  </Icon>
);
export const ResetIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M4 12a8 8 0 1 0 2.600-5.900M4 4v5h5" />
  </Icon>
);
export const SpeakerIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM16 9a4.200 4.200 0 0 1 0 6M18.500 6.500a8 8 0 0 1 0 11" />
  </Icon>
);
export const MuteIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM16 9.500l5 5M21 9.500l-5 5" />
  </Icon>
);
export const PanelIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="3.500" y="4.500" width="17" height="15" rx="2.500" />
    <path d="M14.500 4.500v15" />
  </Icon>
);
export const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="8.500" y="8.500" width="11" height="11" rx="2" />
    <path d="M15.500 8.500v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Icon>
);
export const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M5 12.500l4.500 4.500L19 7.500" />
  </Icon>
);
export const CrossIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M6.500 6.500l11 11M17.500 6.500l-11 11" />
  </Icon>
);
export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
export const BellIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M6 16.500V11a6 6 0 0 1 12 0v5.500l1.500 2h-15zM10 20.500a2 2 0 0 0 4 0" />
  </Icon>
);
export const WakeIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M3.500 12h2.500M8.500 8v8M12 5v14M15.500 8v8M18 12h2.500" />
  </Icon>
);
export const Logo = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true" focusable="false" {...props}>
    <rect width="32" height="32" rx="8" fill="#161b26" />
    <path d="M6 22a10 10 0 0 1 20 0z" fill="#f2c26b" />
    <rect x="5" y="23" width="22" height="3" rx="1.500" fill="#e8ebf2" />
    <circle cx="16" cy="9" r="2.400" fill="#7cc4ff" />
  </svg>
);
