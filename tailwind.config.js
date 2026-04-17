/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["DM Mono", "Fira Code", "ui-monospace", "monospace"],
        syne: ["Syne", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
