const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const Svg = ({ children, size = 18, className = '', ...rest }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base} {...rest}>
    {children}
  </svg>
)

export const Logo = ({ size = 32, className = '' }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} className={className}>
    <rect width="32" height="32" rx="9" fill="url(#lg)" />
    <path d="M8 20.5l3.6-8 2.9 5.6 2-3.1 2.2 3.4 1.6-2.2 3.7 4.3" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <defs>
      <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
        <stop stopColor="#3b82f6" />
        <stop offset="1" stopColor="#1d4ed8" />
      </linearGradient>
    </defs>
  </svg>
)

export const Grid = (p) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></Svg>
export const Upload = (p) => <Svg {...p}><path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></Svg>
export const Layers = (p) => <Svg {...p}><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></Svg>
export const FileText = (p) => <Svg {...p}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></Svg>
export const UserPlus = (p) => <Svg {...p}><path d="M15 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M18 8v6M21 11h-6"/></Svg>
export const Users = (p) => <Svg {...p}><path d="M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 00-3-3.87"/><path d="M16 4.13a4 4 0 010 7.75"/></Svg>
export const Bell = (p) => <Svg {...p}><path d="M18 8a6 6 0 10-12 0c0 6-2 7-2 7h16s-2-1-2-7z"/><path d="M13.7 20a2 2 0 01-3.4 0"/></Svg>
export const Search = (p) => <Svg {...p}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></Svg>
export const Check = (p) => <Svg {...p}><path d="M20 6L9 17l-5-5"/></Svg>
export const CheckCircle = (p) => <Svg {...p}><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></Svg>
export const X = (p) => <Svg {...p}><path d="M18 6L6 18M6 6l12 12"/></Svg>
export const Alert = (p) => <Svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></Svg>
export const Clock = (p) => <Svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></Svg>
export const Shield = (p) => <Svg {...p}><path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6l7-3z"/><path d="M9.2 12.2l1.9 1.9 3.7-4"/></Svg>
export const Lock = (p) => <Svg {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/></Svg>
export const Mail = (p) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></Svg>
export const Phone = (p) => <Svg {...p}><path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 006.1 6.1l1.4-2 4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 5.7 2 2 0 016.5 3.5z"/></Svg>
export const Whatsapp = ({ size = 18, className = '' }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="currentColor">
    <path d="M12.04 2C6.6 2 2.2 6.4 2.2 11.84c0 1.94.55 3.75 1.5 5.29L2 22l4.99-1.63a9.8 9.8 0 005.05 1.38h.01c5.43 0 9.84-4.4 9.84-9.84 0-2.63-1.02-5.1-2.88-6.96A9.78 9.78 0 0012.04 2zm0 1.8a8 8 0 015.7 2.36 8 8 0 012.35 5.68c0 4.45-3.6 8.05-8.05 8.05a8.1 8.1 0 01-4.13-1.13l-.3-.18-3.06 1 1.02-2.98-.2-.3a7.98 7.98 0 01-1.22-4.26c0-4.45 3.62-8.05 8.06-8.05zm-2.6 3.9c-.19 0-.5.07-.76.35-.26.28-1 .98-1 2.4 0 1.4 1.03 2.76 1.17 2.95.14.19 2 3.05 4.85 4.16 2.36.93 2.84.75 3.35.7.51-.05 1.65-.67 1.88-1.32.23-.65.23-1.2.16-1.32-.07-.12-.26-.19-.54-.33-.28-.14-1.65-.82-1.9-.91-.26-.1-.44-.14-.63.14-.19.28-.72.9-.88 1.09-.16.19-.33.21-.6.07-.28-.14-1.18-.44-2.25-1.39-.83-.74-1.39-1.65-1.55-1.93-.16-.28-.02-.43.12-.57.13-.13.28-.33.42-.5.14-.16.19-.28.28-.47.1-.19.05-.35-.02-.49-.07-.14-.62-1.52-.86-2.08-.22-.54-.45-.47-.62-.48h-.53z"/>
  </svg>
)
export const Download = (p) => <Svg {...p}><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 20h16"/></Svg>
export const Eye = (p) => <Svg {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></Svg>
export const Trash = (p) => <Svg {...p}><path d="M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2"/><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12"/></Svg>
export const Refresh = (p) => <Svg {...p}><path d="M20 11a8 8 0 10-2.3 6"/><path d="M20 5v6h-6"/></Svg>
export const ChevronRight = (p) => <Svg {...p}><path d="M9 6l6 6-6 6"/></Svg>
export const ChevronDown = (p) => <Svg {...p}><path d="M6 9l6 6 6-6"/></Svg>
export const ArrowLeft = (p) => <Svg {...p}><path d="M19 12H5m0 0l6-6m-6 6l6 6"/></Svg>
export const ArrowRight = (p) => <Svg {...p}><path d="M5 12h14m0 0l-6-6m6 6l-6 6"/></Svg>
export const Send = (p) => <Svg {...p}><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-8-8-4L21 3z"/></Svg>
export const Share = (p) => <Svg {...p}><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/></Svg>
export const Activity = (p) => <Svg {...p}><path d="M3 12h4l2.5-7 5 14L17 12h4"/></Svg>
export const Database = (p) => <Svg {...p}><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></Svg>
export const Cloud = (p) => <Svg {...p}><path d="M7 18a4.5 4.5 0 01-.5-8.97A6 6 0 0118 9.5a4.25 4.25 0 01-.5 8.5H7z"/></Svg>
export const Image = (p) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 17l4.5-4.5a2 2 0 012.8 0L16 17"/><path d="M14.5 15l1.6-1.6a2 2 0 012.8 0L20.5 15"/></Svg>
export const Stethoscope = (p) => <Svg {...p}><path d="M5 3v5a4 4 0 008 0V3"/><path d="M5 3H3.5M13 3h1.5"/><path d="M9 15v-2"/><path d="M9 15a5 5 0 0010 0v-1.5"/><circle cx="19" cy="11" r="2"/></Svg>
export const Building = (p) => <Svg {...p}><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8h1.5M13.5 8H15M9 12h1.5M13.5 12H15M10.5 21v-4h3v4"/></Svg>
export const Settings = (p) => <Svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007.5 19l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 13.6H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1A1.6 1.6 0 0016.5 5l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5.4z"/></Svg>
export const LogOut = (p) => <Svg {...p}><path d="M9 20H6a2 2 0 01-2-2V6a2 2 0 012-2h3"/><path d="M15 12H10m10 0l-4-4m4 4l-4 4"/></Svg>
export const Zap = (p) => <Svg {...p}><path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></Svg>
export const Play = (p) => <Svg {...p}><path d="M7 4.5l12 7.5-12 7.5v-15z"/></Svg>
export const Pause = (p) => <Svg {...p}><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></Svg>
export const Filter = (p) => <Svg {...p}><path d="M3 5h18l-7 8v5.5l-4 2V13L3 5z"/></Svg>
export const Calendar = (p) => <Svg {...p}><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></Svg>
export const Pencil = (p) => <Svg {...p}><path d="M4 20h4L20 8a2.5 2.5 0 00-3.5-3.5L4 16.5V20z"/><path d="M14.5 6.5l3.5 3.5"/></Svg>
export const Link = (p) => <Svg {...p}><path d="M10.5 13.5a4 4 0 005.7 0l2.8-2.8a4 4 0 00-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 00-5.7 0l-2.8 2.8a4 4 0 005.7 5.7l1.3-1.3"/></Svg>
export const Copy = (p) => <Svg {...p}><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v1"/></Svg>
export const Sparkle = (p) => <Svg {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/></Svg>
export const Crosshair = (p) => <Svg {...p}><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></Svg>
export const Cube = (p) => <Svg {...p}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></Svg>
export const Curve = (p) => <Svg {...p}><path d="M4 19c4 0 3-7 8-7s4-7 8-7"/><circle cx="4" cy="19" r="1.5"/><circle cx="20" cy="5" r="1.5"/></Svg>
export const Heart = (p) => <Svg {...p}><path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/></Svg>
