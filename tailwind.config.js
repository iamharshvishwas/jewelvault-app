/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'calc(var(--radius) - 0.25rem)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 0.25rem)',
        '2xl': 'calc(var(--radius) + 0.5rem)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'jewel': '0 1px 3px rgba(26,26,46,0.06), 0 1px 2px rgba(26,26,46,0.04)',
        'jewel-md': '0 4px 12px rgba(26,26,46,0.10), 0 2px 4px rgba(26,26,46,0.06)',
        'jewel-lg': '0 8px 24px rgba(26,26,46,0.12), 0 4px 8px rgba(26,26,46,0.06)',
        'gold': '0 4px 12px rgba(184,134,11,0.25)',
      },
      keyframes: {
        'scan-line': {
          '0%': { top: '0%', opacity: '1' },
          '50%': { top: '100%', opacity: '0.8' },
          '100%': { top: '0%', opacity: '1' },
        },
      },
      animation: {
        'scan-line': 'scan-line 2s ease-in-out infinite',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};