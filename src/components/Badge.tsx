type Tone = 'gray' | 'green' | 'blue' | 'amber' | 'red' | 'indigo';
// DESIGN.md: fill = <color>~15% alpha, text = full color. No borders/icons.
const color: Record<Tone, string> = {
  gray: 'var(--status-neutral)',
  green: 'var(--status-positive)',
  blue: 'var(--status-active)',
  amber: '#D97706',
  red: 'var(--status-negative)',
  indigo: 'var(--brand)',
};
export default function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: Tone }) {
  const c = color[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-[1.3] tracking-wide"
      style={{ background: `color-mix(in srgb, ${c} 18%, transparent)`, color: c }}
    >
      {children}
    </span>
  );
}

// DESIGN.md status -> color map (fixed, never re-map):
// new -> Info/blue, outreaching -> brand secondary/indigo,
// replied -> Warning/amber, qualified -> Success/green, dead -> Error/red.
// 3 status signals only: active (blue) / positive (green) / negative (red) + neutral grey.
export function statusTone(status: string): Tone {
  switch (status) {
    case 'new':
    case 'outreaching': return 'blue';       // active / in-progress
    case 'replied':
    case 'responded':
    case 'qualified': return 'green';         // positive
    case 'dead':
    case 'unsubscribed':
    case 'not_responded': return 'red';       // negative
    default: return 'gray';                   // no lead / unknown
  }
}
