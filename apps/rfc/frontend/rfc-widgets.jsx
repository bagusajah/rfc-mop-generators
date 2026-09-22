// RFC-specific custom form widgets used by the schema-driven FormEngine.
// These don't fit the generic field kinds in FieldRenderer (they have
// bespoke layout/state semantics), so they're registered as `custom` widgets
// and the schema references them by name.
import React from "react";
import {
  INK, MUTED, DANGER, CARD, SURFACE, BORDER, R_SM, R_MD,
  FS_XS, FS_SM, FS_MD, FW_MEDIUM,
  CELL_PAD, CELL_PAD_SM, INPUT_PAD,
} from "./core.js";
import { SEC_REQUIREMENTS, secCell, secReasonRequired } from "../rfc-schema.js";
import { SEC_STATUS } from "./form-data.js";

// The 7-row security-requirement matrix. Each row has a No, the requirement
// text, and a {status, reason} cell with a select + reason input. Reason is
// mandatory when status is "Tidak Dap Dipenuhi" / "Tidak Relevan".
export function SecurityGrid({ f, setF, touched }) {
  const rows = f.sec_requirements || [];
  const patch = (idx) => (key) => (e) => {
    const updated = rows.map((v) => secCell(v));
    while (updated.length < SEC_REQUIREMENTS.length) updated.push({ status: "", reason: "" });
    updated[idx] = { ...updated[idx], [key]: e.target.value };
    setF((p) => ({ ...p, sec_requirements: updated }));
  };
  return (
    <div className="scroll-x" style={{ border: BORDER, borderRadius: R_MD, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: FS_MD, minWidth: 520 }}>
        <thead>
          <tr style={{ background: "var(--hover)" }}>
            <th style={{ padding: CELL_PAD, textAlign: "left", width: 32, color: MUTED, fontWeight: FW_MEDIUM }}>No</th>
            <th style={{ padding: CELL_PAD, textAlign: "left", color: MUTED, fontWeight: FW_MEDIUM }}>Requirement</th>
            <th style={{ padding: CELL_PAD, textAlign: "left", minWidth: 240, width: "40%", color: MUTED, fontWeight: FW_MEDIUM }}>Pemenuhan</th>
          </tr>
        </thead>
        <tbody>
          {SEC_REQUIREMENTS.map((req, idx) => {
            const cell = secCell(rows[idx]);
            const needReason = secReasonRequired(cell.status);
            const reasonMissing = needReason && !cell.reason.trim();
            const setField = patch(idx);
            return (
              <tr key={idx} style={{ borderTop: BORDER, verticalAlign: "top" }}>
                <td style={{ padding: CELL_PAD, color: MUTED }}>{idx + 1}</td>
                <td style={{ padding: CELL_PAD, color: INK }}>{req}</td>
                <td style={{ padding: CELL_PAD_SM }}>
                  <div className="flex flex-col gap-1">
                    <select value={cell.status} onChange={setField("status")}
                      aria-label={`Pemenuhan requirement ${idx + 1}: ${req}`}
                      style={{ border: BORDER, borderRadius: R_SM, padding: INPUT_PAD, fontSize: FS_MD, background: CARD, color: INK, width: "100%" }}>
                      <option value="">— pilih —</option>
                      {SEC_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input value={cell.reason} onChange={setField("reason")}
                      aria-label={`Alasan / catatan requirement ${idx + 1}`}
                      placeholder={needReason ? "alasan wajib diisi — jelaskan mengapa" : "alasan / catatan (opsional)"}
                      style={{
                        border: reasonMissing && touched ? `1px solid ${DANGER}` : BORDER,
                        borderRadius: R_SM, padding: INPUT_PAD, fontSize: FS_SM, background: CARD, color: INK, width: "100%",
                      }} />
                    {reasonMissing && (
                      <span style={{ fontSize: FS_XS, color: touched ? DANGER : "var(--faint)" }}>
                        Wajib diisi untuk "{cell.status}"
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// "Disusun oleh" sign-off pair: a read-only mirror of the executor name +
// an editable job-title input. Lives at the top of the Pengesahan section.
export function PreparedSignoff({ f, setF }) {
  const setText = (key) => (e) => setF((p) => ({ ...p, [key]: e.target.value }));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <input className="w-full rounded-md px-3 py-2 outline-none"
        style={{ border: BORDER, background: SURFACE, color: MUTED, fontSize: 14 }}
        value={f.executor} readOnly tabIndex={-1} placeholder="(dari Pelaksana)" />
      <input className="w-full rounded-md px-3 py-2 outline-none"
        style={{ border: BORDER, background: "var(--input-bg)", fontSize: 14, color: INK }}
        value={f.prepared_title ?? ""} onChange={setText("prepared_title")}
        placeholder="Jabatan, mis. Engineer" />
    </div>
  );
}

export const rfcWidgets = {
  SecurityGrid,
  PreparedSignoff,
};
