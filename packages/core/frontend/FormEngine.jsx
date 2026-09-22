// Schema-driven form body. Renders an ordered list of sections, each with an
// anchor id (for the section nav), an icon, a label, and a list of fields.
//
//   <FormEngine schema={SECTIONS} f={f} setF={setF} touched={touched}
//               errKeys={errKeys} tools={tools} />
//
// The surrounding chrome (FormNav, AI draft bar, sticky preview aside, action
// bar, review/chat panels) is the app form component's job — FormEngine only
// renders the field body. This keeps it focused: layout from schema, while the
// app retains control of its workflow UI.
//
// `tools` carries the widget deps FieldRenderer needs (TagInput, RowTable,
// datalists, custom widgets). The app builds this once and passes it down.
import React from "react";
import { SectionHead } from "./components.jsx";
import { renderField } from "./FieldRenderer.jsx";
import { CARD, BORDER } from "./tokens.js";

export function FormEngine({ schema, f, setF, touched = false, errKeys = new Set(), tools = {} }) {
  return (
    <div className="flex flex-col gap-6">
      {schema.map((section) => (
        <Section key={section.id} section={section} f={f} setF={setF}
          touched={touched} errKeys={errKeys} tools={tools} />
      ))}
    </div>
  );
}

function Section({ section, f, setF, touched, errKeys, tools }) {
  const Icon = section.icon;
  return (
    <div id={section.anchorId ?? `sec-${section.id}`}
      className="flex flex-col gap-3 scroll-mt-32 rounded-lg p-4"
      style={{ background: CARD, border: BORDER }}>
      <SectionHead icon={Icon} label={section.label} badge={section.badge?.(f)} />
      {section.fields.map((field, i) => (
        // Group wrappers have no `key` of their own — fall back to the index.
        <React.Fragment key={field.key ?? `group-${i}`}>
          {renderField(field, f, setF, { touched, errKeys, tools })}
        </React.Fragment>
      ))}
    </div>
  );
}

// Helper for building an errKeys Set from a list of {field, label} blockers
// (the form's `missingFields`). Returns a Set of field keys to flag in red.
export const errKeysFrom = (missing) =>
  new Set((missing || []).map((m) => m.field).filter(Boolean));
