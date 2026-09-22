/** @type {import('tailwindcss').Config} */
export default {
  // Scan this app's files AND the shared core (components/AppShell/LlmSettings
  // live in packages/core/frontend) so Tailwind purges nothing the UI uses.
  content: [
    "./index.html",
    "./**/*.{js,jsx}",
    "../../../packages/core/frontend/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      // Semantic colors backed by CSS vars — theme-aware (flip in .dark) for
      // the primitives, fixed for the status families. Lets any future
      // bg-card / text-muted / border-line utility stay on the token system.
      colors: {
        ink: "var(--ink)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        line: "var(--line)",
        accent: "var(--accent)",
        surface: "var(--surface)",
        card: "var(--card)",
        hover: "var(--hover)",
        google: "var(--google)",
        neutral: {
          bg: "var(--neutral-bg)",
          fg: "var(--neutral-fg)",
          dot: "var(--neutral-dot)",
        },
        warn: {
          bg: "var(--warn-bg)",
          fg: "var(--warn-fg)",
          dot: "var(--warn-dot)",
          border: "var(--warn-border)",
          panel: "var(--warn-panel)",
        },
        info: {
          bg: "var(--info-bg)",
          fg: "var(--info-fg)",
          dot: "var(--info-dot)",
        },
        success: {
          bg: "var(--success-bg)",
          panel: "var(--success-panel)",
          border: "var(--success-border)",
          fg: "var(--success-fg)",
          icon: "var(--success-icon)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          bg: "var(--danger-bg)",
          "bg-strong": "var(--danger-bg-strong)",
          fg: "var(--danger-fg)",
          "fg-strong": "var(--danger-fg-strong)",
        },
        tag: {
          bg: "var(--tag-bg)",
          fg: "var(--tag-fg)",
        },
      },
      borderRadius: {
        DEFAULT: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-sm)",
        lg: "var(--radius-md)",
        xl: "var(--radius-md)",
        pill: "var(--radius-pill)",
      },
      fontSize: {
        xs: ["var(--fs-xs)", { lineHeight: "1.4" }],
        sm: ["var(--fs-sm)", { lineHeight: "1.4" }],
        md: ["var(--fs-md)", { lineHeight: "1.45" }],
        base: ["var(--fs-base)", { lineHeight: "1.5" }],
        lg: ["var(--fs-lg)", { lineHeight: "1.5" }],
        xl: ["var(--fs-xl)", { lineHeight: "1.5" }],
        "2xl": ["var(--fs-2xl)", { lineHeight: "1.3" }],
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
    },
  },
  plugins: [],
};
