/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 4px 16px -4px rgba(16,24,40,.08)',
        pop: '0 8px 32px -8px rgba(37,99,235,.28)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'none' } },
        'fade-in': { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        'scale-in': { '0%': { opacity: 0, transform: 'scale(.96)' }, '100%': { opacity: 1, transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(37,99,235,.35)' },
          '70%': { boxShadow: '0 0 0 12px rgba(37,99,235,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(37,99,235,0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .35s cubic-bezier(.16,1,.3,1) both',
        'fade-in': 'fade-in .25s ease both',
        'scale-in': 'scale-in .2s cubic-bezier(.16,1,.3,1) both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-ring': 'pulse-ring 1.8s infinite',
      },
    },
  },
  plugins: [],
}
