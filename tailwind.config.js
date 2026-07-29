/** @type {import('tailwindcss').Config} */
// Brand remap: white + blue + red-tint, matte. `slate` carries text/border/surface
// roles; `indigo` → brand blue. All values are CSS vars so the same classes flip
// between light and dark mode. Surfaces (bg-white/slate-50) flip in globals.css.
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
    },
  },
  plugins: [],
};
