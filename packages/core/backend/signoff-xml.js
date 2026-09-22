// Builds the "Pengesahan Dokumen" sign-off tables as raw OOXML, injected into
// the template through the {@signoff} tag at render time. docxtemplater's free
// row-loops can only repeat table ROWS, but the official form lays signatories
// out HORIZONTALLY — one bordered box per signer with a role label, an empty
// signing space, the printed name, and the jabatan underneath. A dynamic
// number of COLUMNS is only possible by assembling the table XML ourselves.
//
// Layout mirrors the official template's two sign-off tables: a full group of
// "Disusun oleh" + "Direview oleh" boxes under the grey "Pengesahan Dokumen"
// header, then a separate table of "Disetujui oleh" boxes. Groups wider than
// MAX_PER_ROW wrap onto an extra stacked table, which is exactly how manually
// edited forms in RFC/ handle 5+ signers.

const MAX_PER_ROW = 3;
const BOX_W = 2890; // dxa per signer box — the official 3-col table is 8670 wide
const SIG_LINES = 5; // empty lines above the printed name (room for the signature)

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const SZ = '<w:sz w:val="20"/><w:szCs w:val="20"/>';
const BOLD = '<w:b w:val="1"/><w:bCs w:val="1"/>';

const para = (text, { bold = false, align = "left", before = 0 } = {}) => {
  const rpr = (bold ? BOLD : "") + SZ;
  const run = text
    ? `<w:r><w:rPr>${rpr}<w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
    : "";
  return (
    `<w:p><w:pPr><w:spacing${before ? ` w:before="${before}"` : ""} w:line="240" w:lineRule="auto"/>` +
    `<w:jc w:val="${align}"/><w:rPr>${rpr}</w:rPr></w:pPr>${run}</w:p>`
  );
};

const tc = (paras, { span = 0, shd = "" } = {}) => {
  const pr =
    (span > 1 ? `<w:gridSpan w:val="${span}"/>` : "") +
    (shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${shd}"/>` : "");
  return `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : "<w:tcPr/>"}${paras}</w:tc>`;
};

const tr = (cells) => `<w:tr>${cells.join("")}</w:tr>`;

const BORDERS = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((side) => `<w:${side} w:color="000000" w:space="0" w:sz="4" w:val="single"/>`)
  .join("");

const table = (nCols, rows) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="Table6"/><w:tblW w:w="${BOX_W * nCols}" w:type="dxa"/>` +
  `<w:jc w:val="center"/><w:tblBorders>${BORDERS}</w:tblBorders>` +
  `<w:tblLayout w:type="fixed"/><w:tblLook w:val="0400"/></w:tblPr>` +
  `<w:tblGrid>${`<w:gridCol w:w="${BOX_W}"/>`.repeat(nCols)}</w:tblGrid>` +
  rows.join("") +
  `</w:tbl>`;

// Empty paragraph between/after tables — Word merges adjacent tables into one
// when nothing separates them, and requires a paragraph after a trailing table.
const SPACER = '<w:p><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:p>';

// One table for a chunk of ≤ MAX_PER_ROW signers: label row, signing-space row
// (blank lines with the printed name at the bottom, so the signature sits above
// it like on the official form), then the jabatan row.
const chunkTable = (signers, { header = false } = {}) => {
  const rows = [];
  if (header) {
    rows.push(tr([tc(
      para("Pengesahan Dokumen", { bold: true, align: "center", before: 120 }),
      { span: signers.length, shd: "e6e6e6" },
    )]));
  }
  rows.push(tr(signers.map((s) => tc(para(`${s.role} :`)))));
  rows.push(tr(signers.map((s) =>
    tc(para("").repeat(SIG_LINES) + para(s.name, { align: "center" })))));
  rows.push(tr(signers.map((s) => tc(para(s.title, { align: "center" })))));
  return table(signers.length, rows);
};

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export function buildSignoffXml({ prepared = {}, reviewers = [], approvers = [] } = {}) {
  const groupA = [
    { role: "Disusun oleh", name: prepared.name || "", title: prepared.title || "" },
    ...reviewers.map((s) => ({ role: "Direview oleh", name: s.name || "", title: s.title || "" })),
  ];
  const groupB = approvers.map((s) => ({ role: "Disetujui oleh", name: s.name || "", title: s.title || "" }));

  const tables = [
    ...chunk(groupA, MAX_PER_ROW).map((c, i) => chunkTable(c, { header: i === 0 })),
    ...chunk(groupB, MAX_PER_ROW).map((c) => chunkTable(c)),
  ];
  return tables.join(SPACER) + SPACER;
}
