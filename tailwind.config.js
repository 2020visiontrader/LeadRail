/** @type {import('tailwindcss').Config} */
// Brand remap: white + blue + red-tint, matte. `slate` carries text/border/surface
// roles; `indigo` → brand blue. All values are CSS vars so the same classes flip
// between light and dark mode. Surfaces (bg-white/slate-50) flip in globals.css.
//
// Dark operator console refresh (DESIGN.md): `.dark` values in globals.css were
// pulled toward the canonical navy/teal operator palette. Token *names* are
// unchanged (many files outside this pass depend on them) — only the dark-mode
// values shifted, plus a 4px spacing/radius scale was added for the settings
// console and restyled primitives to opt into without touching Tailwind's
// built-in scale for existing call sites.
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: {
          50: 'var(--bg-raised)',
          100: 'var(--bg-raised)',
          200: 'var(--border-default)',
          300: 'var(--border-strong)',
          400: 'var(--text-muted)',
          500: 'var(--text-secondary)',
          600: 'var(--text-secondary)',
          700: 'var(--text-secondary)',
          800: 'var(--text-primary)',
          900: 'var(--text-primary)',
        },
        indigo: {
          50: 'var(--brand-soft)',
          100: 'var(--brand-soft)',
          300: 'var(--brand)',
          400: 'var(--brand)',
          500: 'var(--brand)',
          600: 'var(--brand)',
          700: 'var(--brand-hover)',
          800: 'var(--brand-hover)',
        },
      },
      spacing: {
        '4.5': '18px',
        '18': '72px',
      },
      borderRadius: {
        'card-sm': 'var(--radius-card-sm, 10px)',
      },
      boxShadow: {
        'op-1': 'var(--shadow-1, 0 2px 8px rgba(0,0,0,0.12))',
        'op-2': 'var(--shadow-2, 0 4px 12px rgba(0,0,0,0.15))',
        'op-3': 'var(--shadow-3, 0 8px 24px rgba(0,0,0,0.18))',
      },
    },
  },
  plugins: [],
};
