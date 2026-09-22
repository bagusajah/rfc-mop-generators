// Design tokens. All values reference CSS custom properties in index.css
// (:root and .dark). Primitives (INK/MUTED/LINE/…) flip with the theme; status
// colors are fixed across themes (dark text on light pastel).

// Theme-variant primitives
export const INK     = "var(--ink)";
export const MUTED   = "var(--muted)";
export const FAINT   = "var(--faint)";
export const LINE    = "var(--line)";
export const ACCENT  = "var(--accent)";
export const SURFACE = "var(--surface)";
export const CARD    = "var(--card)";
export const INPUT_BG = "var(--input-bg)";
export const HOVER   = "var(--hover)";
export const GOOGLE  = "var(--google)";
export const ACCENT_DISABLED = "var(--accent-disabled)";
export const ON_ACCENT = "var(--on-accent)";
export const ON_ACCENT_DISABLED = "var(--on-accent-disabled)";

// Status / semantic colors (fixed across themes)
export const NEUTRAL_BG = "var(--neutral-bg)", NEUTRAL_FG = "var(--neutral-fg)";
export const WARN_BG = "var(--warn-bg)", WARN_FG = "var(--warn-fg)",
             WARN_BORDER = "var(--warn-border)", WARN_PANEL = "var(--warn-panel)";
export const INFO_BG = "var(--info-bg)", INFO_FG = "var(--info-fg)",
             INFO_BORDER = "var(--info-border)", INFO_PANEL = "var(--info-panel)";
export const SUCCESS_BG = "var(--success-bg)", SUCCESS_PANEL = "var(--success-panel)",
             SUCCESS_BORDER = "var(--success-border)", SUCCESS_FG = "var(--success-fg)",
             SUCCESS_ICON = "var(--success-icon)";
// Theme-variant success green for text on a themed surface (--card/--surface),
// as opposed to SUCCESS_FG which is fixed and belongs on a fixed-bg chip.
export const SUCCESS_INK = "var(--success-ink)";
export const DANGER  = "var(--danger)";
export const DANGER_BG = "var(--danger-bg)", DANGER_BG_STRONG = "var(--danger-bg-strong)",
             DANGER_FG = "var(--danger-fg)", DANGER_FG_STRONG = "var(--danger-fg-strong)",
             DANGER_BORDER = "var(--danger-border)", DANGER_PANEL = "var(--danger-panel)";
export const TAG_BG = "var(--tag-bg)", TAG_FG = "var(--tag-fg)";
export const TEAM_DBA = "var(--team-dba)";

// Layout
export const R_SM = "var(--radius-sm)",
             R_MD = "var(--radius-md)", R_PILL = "var(--radius-pill)";
export const FS_XS = 11, FS_SM = 12, FS_MD = 13, FS_BASE = 14, FS_LG = 15, FS_XL = 16, FS_2XL = 24;
export const FW_NORMAL = 400, FW_MEDIUM = 500, FW_SEMIBOLD = 600;
export const CELL_PAD = "var(--cell-pad)", CELL_PAD_SM = "var(--cell-pad-sm)",
             INPUT_PAD = "var(--input-pad)";
export const BORDER = `1px solid ${LINE}`;   // the standard hairline border
export const FONT_SANS = "var(--font-sans)";
export const FONT_MONO = "var(--font-mono)";
export const FONT_DISPLAY = "var(--font-display)";
export const mono = { fontFamily: FONT_MONO };

// Semantic style maps — built from the tokens above.
export const URGENSI_STYLE = {
  // Severity ascends Low → Critical, so the strongest danger styling is reserved
  // for Critical (not High) — keep these in sync with that order.
  Low:      { background: NEUTRAL_BG,        color: NEUTRAL_FG },
  Medium:   { background: WARN_BG,           color: WARN_FG },
  High:     { background: DANGER_BG,         color: DANGER_FG },
  Critical: { background: DANGER_BG_STRONG,  color: DANGER_FG_STRONG },
};

export const RISK_LEVEL_STYLE = {
  Low:    { background: SUCCESS_BG, color: SUCCESS_FG },
  Medium: { background: WARN_BG,    color: WARN_FG },
  High:   { background: DANGER_BG,  color: DANGER_FG },
};

// `panel`/`border` back each finding card's tinted background + left accent
// stripe (FindingCard); `bg`/`fg` back the small severity pill inside it.
export const SEVERITY_STYLE = {
  block: { bg: DANGER_BG, fg: DANGER_FG, label: "Wajib diperbaiki", panel: DANGER_PANEL, border: DANGER_BORDER },
  warn:  { bg: WARN_BG,   fg: WARN_FG,   label: "Berisiko revisi",  panel: WARN_PANEL,   border: WARN_BORDER },
  info:  { bg: INFO_BG,   fg: INFO_FG,   label: "Saran",            panel: INFO_PANEL,   border: INFO_BORDER },
};

export const TEAM_FG = { SRE: ACCENT, DBA: TEAM_DBA };

export const inputCls = "w-full rounded-md px-3 py-2 outline-none";
export const inputStyle = { border: BORDER, background: INPUT_BG, fontSize: FS_BASE, color: INK };
