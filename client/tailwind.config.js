/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#fdf4f0',
          100: '#fbe8de',
          200: '#f6ccb8',
          300: '#f0a989',
          400: '#e87f56',
          500: '#d95f32',
          600: '#c24825',
          700: '#a1371d',
          800: '#832e1c',
          900: '#6c281a',
        },
        cream: {
          DEFAULT: '#F5F0EB',
          50: '#FDFAF7',
          100: '#F5F0EB',
          200: '#EDE8E3',
          300: '#DDD6CE',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'warm-sm': '0 1px 3px 0 rgba(100, 60, 20, 0.08), 0 1px 2px -1px rgba(100, 60, 20, 0.05)',
        'warm':    '0 4px 12px 0 rgba(100, 60, 20, 0.10), 0 2px 4px -1px rgba(100, 60, 20, 0.06)',
        'warm-lg': '0 8px 24px 0 rgba(100, 60, 20, 0.12), 0 4px 8px -2px rgba(100, 60, 20, 0.08)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
    },
  },
  plugins: [],
};
