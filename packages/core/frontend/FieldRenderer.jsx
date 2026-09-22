// Field renderer: maps a field-schema `kind` to its input widget.
//
// Each field schema has the shape:
//   { key, kind, label, hint?, required?, ...kind-specific-opts }
//
// All widgets take the live form value `f`, a setter `setF` (whole-form
// updater), and the `field` schema. They read f[field.key] and write back via
// setF. The wrapping <Field> label/hint/required chrome is applied uniformly
// by the engine, so individual widgets focus on the input itself.
//
// `tools` is a bag of helpers the app may supply (see FormEngine): a `datalist`
// registry, custom widgets, transforms applied on change, etc. Kept minimal —
// the engine's job is layout, the app's job is domain semantics.
import React from "react";
import { Field } from "./components.jsx";
import {
  INK, MUTED, DANGER, DANGER_FG_STRONG, CARD, SURFACE, INPUT_BG, BORDER, R_SM, R_MD,
  FS_XS, FS_SM, FS_BASE, FW_NORMAL, FW_SEMIBOLD,
  CELL_PAD, CELL_PAD_SM, INPUT_PAD,
  inputCls, inputStyle,
} from "./tokens.js";

// onChange helper: set f[key] = value (string from event or arbitrary value).
const setText = (setF, key) => (e) => setF((p) => ({ ...p, [key]: e.target.value }));
const setVal  = (setF, key) => (v)  => setF((p) => ({ ...p, [key]: v }));

export function renderField(field, f, setF, { touched, errKeys = new Set(), tools = {} } = {}) {
  const errStyle = (k) =>
    (touched && errKeys.has(k)) ? { ...inputStyle, borderColor: DANGER } : inputStyle;

  const common = {
    id: field.fieldId,
    label: field.label,
    hint: field.hint,
    required: field.required,
  };

  switch (field.kind) {
    /* ── text ── */
    case "text": {
      const datalist = field.datalist && tools.datalists?.[field.datalist];
      return (
        <Field {...common}>
          <input className={inputCls} style={errStyle(field.key)} value={f[field.key] ?? ""}
            onChange={setText(setF, field.key)} placeholder={field.placeholder}
            list={field.datalist} />
          {datalist && (
            <datalist id={field.datalist}>
              {datalist.map((v) => <option key={v} value={v} />)}
            </datalist>
          )}
        </Field>
      );
    }

    /* ── textarea ── */
    case "textarea": {
      return (
        <Field {...common}>
          <textarea className={inputCls}
            style={{ ...inputStyle, minHeight: field.minHeight ?? 72, resize: "vertical", lineHeight: 1.6 }}
            value={f[field.key] ?? ""} onChange={setText(setF, field.key)}
            placeholder={field.placeholder} />
        </Field>
      );
    }

    /* ── date ── */
    case "date": {
      // Optional side effect when the date changes (RFC derives `jadwal_hari`).
      const onChange = field.derive
        ? (e) => setF((p) => ({ ...p, [field.key]: e.target.value, ...field.derive(e.target.value, p) }))
        : setText(setF, field.key);
      return (
        <Field {...common}>
          <input type="date" className={inputCls} style={errStyle(field.key)}
            value={f[field.key] ?? ""} onChange={onChange} />
        </Field>
      );
    }

    /* ── time ── */
    case "time": {
      return (
        <Field {...common}>
          <input type="time" className={inputCls} style={inputStyle}
            value={f[field.key] ?? ""} onChange={setText(setF, field.key)} />
        </Field>
      );
    }

    /* ── datetime ── a local datetime picker (input type=datetime-local). */
    case "datetime": {
      return (
        <Field {...common}>
          <input type="datetime-local" className={inputCls} style={inputStyle}
            value={f[field.key] ?? ""} onChange={setText(setF, field.key)} />
        </Field>
      );
    }

    /* ── select ── options: ["a","b"] or [{optgroup, items}] or {options, placeholder} */
    case "select": {
      const groups = field.groups ?? null;
      const flat   = field.options ?? [];
      return (
        <Field {...common}>
          <select className={inputCls} style={errStyle(field.key)}
            value={f[field.key] ?? ""} onChange={setText(setF, field.key)}>
            {field.placeholder != null && <option value="">{field.placeholder}</option>}
            {groups
              ? groups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.items.map((c) => <option key={c}>{c}</option>)}
                  </optgroup>
                ))
              : flat.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      );
    }

    /* ── radio ── options: [{ value, note?, dangerStyle? }] */
    case "radio": {
      return (
        <Field {...common}>
          <div className="flex gap-3">
            {(field.options ?? []).map((opt) => {
              const v = typeof opt === "string" ? opt : opt.value;
              const note = typeof opt === "string" ? null : opt.note;
              const danger = typeof opt === "string" ? false : opt.dangerStyle;
              return (
                <label key={v} className="flex items-center gap-2 cursor-pointer" style={{ fontSize: FS_BASE }}>
                  <input type="radio" name={field.key} value={v}
                    checked={f[field.key] === v}
                    onChange={() => setF((p) => ({ ...p, [field.key]: v }))} />
                  <span style={{ fontWeight: f[field.key] === v ? FW_SEMIBOLD : FW_NORMAL, color: danger ? DANGER_FG_STRONG : INK }}>
                    {v}
                  </span>
                  {note && <span style={{ fontSize: FS_SM, color: DANGER_FG_STRONG }}>{note}</span>}
                </label>
              );
            })}
          </div>
        </Field>
      );
    }

    /* ── taginput (multi-value chips) ── uses TagInput from components.jsx */
    case "taginput": {
      const TagInput = tools.TagInput;
      if (!TagInput) throw new Error("renderField taginput requires tools.TagInput");
      return (
        <Field {...common}>
          <TagInput value={f[field.key] ?? []} onChange={setVal(setF, field.key)}
            options={field.options} placeholder={field.placeholder}
            error={touched && field.required && !(f[field.key]?.length)} />
        </Field>
      );
    }

    /* ── rowtable (dynamic table driven by column defs) ── */
    case "rowtable": {
      const RowTable = tools.RowTable;
      if (!RowTable) throw new Error("renderField rowtable requires tools.RowTable");
      return (
        <Field label={field.label} hint={field.hint}>
          <RowTable
            rows={f[field.key] ?? []}
            onChange={setVal(setF, field.key)}
            columns={field.columns}
            addLabel={field.addLabel}
            transform={field.transform}
            minWidth={field.minWidth}
          />
        </Field>
      );
    }

    /* ── custom ── an app-supplied widget, looked up by name in tools.widgets */
    case "custom": {
      const Widget = tools.widgets?.[field.widget];
      if (!Widget) throw new Error(`renderField custom: unknown widget "${field.widget}"`);
      return <Widget field={field} f={f} setF={setF} touched={touched} errKeys={errKeys} />;
    }

    /* ── group ── a responsive grid wrapper around nested fields */
    case "group": {
      // Literal class map — Tailwind only emits utilities it finds as literal
      // strings in source, so a template `sm:grid-cols-${cols}` is never generated.
      const colsCls = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[field.cols ?? 2]
        || "sm:grid-cols-2";
      return (
        <div className={`grid grid-cols-1 ${colsCls} gap-3`}>
          {(field.fields ?? []).map((sub) => (
            <React.Fragment key={sub.key}>
              {renderField(sub, f, setF, { touched, errKeys, tools })}
            </React.Fragment>
          ))}
        </div>
      );
    }

    default:
      return <Field label={field.label}><div style={{ color: DANGER, fontSize: FS_SM }}>Unknown field kind: {field.kind}</div></Field>;
  }
}
