#!/usr/bin/env python3
"""Replace the sign-off tables with a single {@signoff} raw-XML anchor.

The backend builds the "Pengesahan Dokumen" signature-box tables as OOXML at
render time (packages/core/backend/signoff-xml.js) and injects them through
docxtemplater's raw-XML tag. That is what lets the form carry any number of
signatories while keeping the official HORIZONTAL layout — one bordered box
per signer — since docxtemplater's free row-loops can only repeat rows
vertically.

Run AFTER `npm run template` (apply_template.py leaves the official sign-off
tables untouched; this replaces them):

    python3 tools/apply_signoff.py apps/rfc/backend/rfc_template.docx

Handles either input state:
  * official template — the "Pengesahan" table plus the "Disetujui" approver
    table that follows it (and the spacer paragraph between them)
  * previously prepared template — the legacy vertical {#reviewers} loop table
"""
import sys, re, zipfile, shutil

# The whole paragraph is replaced by the built tables at render time. The tag
# must live in a single run so docxtemplater sees it unsplit.
ANCHOR = (
    '<w:p><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>'
    '<w:r><w:t xml:space="preserve">{@signoff}</w:t></w:r></w:p>'
)


def transform(xml):
    tbls = list(re.finditer(r'<w:tbl>.*?</w:tbl>', xml, re.S))
    # Previously prepared template: swap the legacy vertical loop table.
    legacy = next((m for m in tbls if '{#reviewers}' in m.group(0)), None)
    if legacy:
        return xml[:legacy.start()] + ANCHOR + xml[legacy.end():]
    # Official template: Pengesahan table + the approver table right after it.
    a = next((m for m in tbls if 'Pengesahan' in m.group(0)), None)
    if not a:
        raise SystemExit("✗ Could not find the 'Pengesahan' sign-off table.")
    b = next((m for m in tbls if m.start() > a.start()), None)
    if not b or 'Disetujui' not in b.group(0):
        raise SystemExit("✗ Could not find the 'Disetujui' approver table after Pengesahan.")
    # Replace from the start of the Pengesahan table through the end of the
    # approver table (drops the spacer paragraph between them too).
    return xml[:a.start()] + ANCHOR + xml[b.end():]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply_signoff.py <template.docx>")
    path = sys.argv[1]
    zin = zipfile.ZipFile(path)
    doc = zin.read("word/document.xml").decode("utf-8")
    if "{@signoff}" in doc:
        print("• Sign-off already anchored — nothing to do.")
        return
    out = transform(doc)
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = out.encode("utf-8") if item.filename == "word/document.xml" else zin.read(item.filename)
            zout.writestr(item, data)
    zin.close()
    shutil.move(tmp, path)
    print(f"✓ Replaced sign-off with the {{@signoff}} anchor in {path}")


if __name__ == "__main__":
    main()
