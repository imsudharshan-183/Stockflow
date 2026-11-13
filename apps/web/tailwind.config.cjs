/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--line)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--bg)",
        foreground: "var(--ink)",
        ink: "var(--ink)",
        disabled: "var(--disabled)",
        "table-header": "var(--table-header)",
        "row-hover": "var(--row-hover)",
        "row-selected": "var(--row-selected)",
        "divider-soft": "var(--divider-soft)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
          hover: "var(--primary-hover)",
          soft: "var(--primary-soft)",
          ring: "var(--primary-ring)",
          text: "var(--primary-text)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--primary-foreground)",
        },
        muted: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--muted)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        gain: {
          DEFAULT: "var(--gain)",
          bg: "var(--gain-bg)",
          hover: "var(--gain-hover)",
          ring: "var(--gain-ring)",
          text: "var(--gain-text)",
        },
        risk: {
          DEFAULT: "var(--risk)",
          bg: "var(--risk-bg)",
          hover: "var(--risk-hover)",
          ring: "var(--risk-ring)",
          text: "var(--risk-text)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          bg: "var(--warn-bg)",
          ring: "var(--warn-ring)",
          text: "var(--warn-text)",
        },
        info: {
          DEFAULT: "var(--info)",
          bg: "var(--info-bg)",
          ring: "var(--info-ring)",
          text: "var(--info-text)",
        },
        indigo: {
          bg: "var(--indigo-bg)",
          ring: "var(--indigo-ring)",
          text: "var(--indigo-text)",
        },
        neutral: {
          bg: "var(--neutral-bg)",
          ring: "var(--neutral-ring)",
          text: "var(--neutral-text)",
        },
        success: "var(--gain)",
        danger: "var(--risk)",
      },
      borderRadius: {
        "2xl": "16px",
        xl: "12px",
        lg: "var(--radius)",
        md: "10px",
        sm: "8px",
      },
      boxShadow: {
        xs: "0 1px 2px rgba(20, 17, 43, 0.06)",
        card: "0 1px 2px rgba(20, 17, 43, 0.04), 0 8px 24px -12px rgba(20, 17, 43, 0.10)",
        primary: "0 1px 2px rgba(109, 40, 217, 0.25), 0 6px 16px -4px rgba(109, 40, 217, 0.35)",
        "primary-hover": "0 2px 4px rgba(109, 40, 217, 0.25), 0 10px 22px -4px rgba(109, 40, 217, 0.45)",
        pop: "0 12px 40px -8px rgba(20, 17, 43, 0.25)",
        badge: "0 1px 1px rgba(20, 17, 43, 0.04)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
};
