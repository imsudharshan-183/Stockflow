/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--line)",
        input: "var(--line)",
        ring: "var(--primary)",
        background: "var(--bg)",
        foreground: "var(--ink)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "#ffffff",
          hover: "var(--primary-hover)",
        },
        secondary: {
          DEFAULT: "var(--lavender-50)",
          foreground: "var(--ink)",
        },
        destructive: {
          DEFAULT: "var(--danger)",
          foreground: "#ffffff",
        },
        muted: {
          DEFAULT: "var(--lavender-50)",
          foreground: "var(--muted)",
        },
        accent: {
          DEFAULT: "var(--lavender-100)",
          foreground: "var(--ink)",
        },
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        success: "var(--success)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        info: "var(--info)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "12px",
        sm: "8px",
      },
      boxShadow: {
        card: "0 8px 24px rgba(31, 27, 58, 0.06)",
      },
    },
  },
  plugins: [],
};
