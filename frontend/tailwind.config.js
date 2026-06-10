/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        tg: {
          bg:        'var(--tg-theme-bg-color)',
          text:      'var(--tg-theme-text-color)',
          hint:      'var(--tg-theme-hint-color)',
          btn:       'var(--tg-theme-button-color)',
          'btn-txt': 'var(--tg-theme-button-text-color)',
          secondary: 'var(--tg-theme-secondary-bg-color)',
        },
      },
    },
  },
  plugins: [],
}
