#!/usr/bin/env python3
"""
apply_template.py — inject docxtemplater placeholders into a fresh
"Form Permintaan Perubahan" Word document, with zero AI involvement.

Whenever the official RFC template is updated, run:

    python3 tools/apply_template.py "<new-template>.docx"

It writes apps/rfc/backend/rfc_template.docx ready for the backend to render.

HOW IT WORKS
------------
The script is *convention-driven*, not position-driven. It finds each
section by its heading text and each table by its column headers, so the
template can be reordered or have its wording tweaked and this still works.
It only breaks if a section heading is renamed or a brand-new field is
added — in which case, edit the SECTIONS / table-classifier rules below.

Run with --check to verify an already-prepared template instead of building.
"""

import sys, os, re, io, zipfile, argparse
from apply_signoff import transform as make_signoff_dynamic  # sibling tool

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "apps", "rfc", "backend", "rfc_template.docx")

# ── XML building blocks ───────────────────────────────────────────────────────

def text_run(s, sz="20", bold=False):
    b = '<w:b w:val="1"/><w:bCs w:val="1"/>' if bold else ''
    return (f'<w:r><w:rPr>{b}<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>'
            f'<w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">{s}</w:t></w:r>')

def simple_para(text, sz="20"):
    ppr = (f'<w:pPr><w:spacing w:line="240" w:lineRule="auto"/>'
           f'<w:rPr><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:pPr>')
    return f'<w:p>{ppr}{text_run(text, sz)}</w:p>'

def stripped(xml):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", xml)).strip()

def set_para_text(p, new_text, sz="20"):
    """Keep a paragraph's pPr, replace all its runs with one text run."""
    ppr = re.search(r"<w:pPr>.*?</w:pPr>", p, re.DOTALL)
    ppr_xml = ppr.group(0) if ppr else ""
    body = re.sub(r"<w:r[ >].*?</w:r>", "", p, flags=re.DOTALL)
    body = re.sub(r"</w:p>\s*$", "", body)
    # Re-insert text run just before the closing tag region we trimmed
    # (body currently ends right after pPr / other non-run children)
    return body + text_run(new_text, sz) + "</w:p>"

def set_cell_text(cell_xml, new_text):
    """Replace all run text in a cell with a single paragraph of new_text."""
    tcpr = re.search(r"<w:tcPr>.*?</w:tcPr>|<w:tcPr/>", cell_xml, re.DOTALL)
    tcpr_xml = tcpr.group(0) if tcpr else ""
    ppr = re.search(r"<w:pPr>.*?</w:pPr>", cell_xml, re.DOTALL)
    ppr_xml = ppr.group(0) if ppr else '<w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>'
    return f"<w:tc>{tcpr_xml}<w:p>{ppr_xml}{text_run(new_text)}</w:p></w:tc>"

def cells_of(row_xml):
    return re.findall(r"<w:tc>.*?</w:tc>", row_xml, re.DOTALL)

def rows_of(tbl_xml):
    return re.findall(r"<w:tr[ >].*?</w:tr>", tbl_xml, re.DOTALL)

def tbl_prefix(tbl_xml):
    """Everything from <w:tbl> up to the first row (tblPr, tblGrid)."""
    m = re.search(r"^<w:tbl>.*?(?=<w:tr[ >])", tbl_xml, re.DOTALL)
    return m.group(0) if m else "<w:tbl>"

def rebuild_table(tbl_xml, new_rows):
    return tbl_prefix(tbl_xml) + "".join(new_rows) + "</w:tbl>"

def row_pr(row_xml):
    m = re.search(r"<w:trPr>.*?</w:trPr>", row_xml, re.DOTALL)
    return m.group(0) if m else ""

# Reusable loop-row builders (3-col) -------------------------------------------

TR_PR = '<w:trPr><w:cantSplit w:val="0"/><w:tblHeader w:val="0"/></w:trPr>'

def loop_row(cells_with_text):
    """cells_with_text: list of (text, pre, post) tuples per column."""
    out = []
    for text, pre, post in cells_with_text:
        ppr = '<w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>'
        paras = ""
        if pre:  paras += f"<w:p>{ppr}{text_run(pre)}</w:p>"
        paras += f"<w:p>{ppr}{text_run(text)}</w:p>"
        if post: paras += f"<w:p>{ppr}{text_run(post)}</w:p>"
        out.append(f"<w:tc><w:tcPr/>{paras}</w:tc>")
    return f"<w:tr>{TR_PR}{''.join(out)}</w:tr>"

def group_header_row(text, span=3):
    """A full-width, grey, bold section-header row (e.g. the tasklist phase
    'Pengerjaan Inti'). One cell spanning all columns."""
    ppr = ('<w:pPr><w:spacing w:line="240" w:lineRule="auto"/>'
           '<w:rPr><w:b w:val="1"/><w:bCs w:val="1"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:pPr>')
    tcpr = (f'<w:tcPr><w:gridSpan w:val="{span}"/>'
            '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/></w:tcPr>')
    return f'<w:tr>{TR_PR}<w:tc>{tcpr}<w:p>{ppr}{text_run(text, bold=True)}</w:p></w:tc></w:tr>'

# ── example/instruction stripping ─────────────────────────────────────────────
# Official templates ship with grey fill-in guidance ("Berisi...", "Contoh:",
# example rows, notes). Those runs use a grey font; real content is black. We
# drop any top-level paragraph whose runs are ALL grey, and strip grey runs from
# mixed paragraphs (e.g. a black heading with a grey parenthetical note).
GREY = {"b7b7b7", "999999", "767171", "808080", "7f7f7f", "a6a6a6", "bfbfbf"}

def _run_is_grey(run):
    m = re.search(r'<w:color w:val="([0-9a-fA-F]{6})"', run)
    return bool(m and m.group(1).lower() in GREY)

def _paragraph_is_grey(p):
    """True if every run in the paragraph is grey — i.e. this IS (or will
    become, once strip_grey runs) an example/instruction line, not real
    content. Read-only counterpart to strip_grey_paragraph, used to keep the
    inline label rules below from matching example text (see their call site)."""
    runs = re.findall(r"<w:r[ >].*?</w:r>", p, flags=re.DOTALL)
    return bool(runs) and all(_run_is_grey(r) for r in runs)

def strip_grey_paragraph(p):
    """Strip grey runs. Drop a paragraph only if it HAD grey text and is now
    empty (a pure example/instruction line); keep genuinely-empty spacer
    paragraphs so the template's vertical spacing is preserved."""
    had_text = bool(stripped(p))
    newp = re.sub(r"<w:r[ >].*?</w:r>",
                  lambda m: "" if _run_is_grey(m.group(0)) else m.group(0),
                  p, flags=re.DOTALL)
    if stripped(newp):
        return newp
    return None if had_text else p

def strip_grey(xml):
    """Drop grey example/instruction paragraphs; leave tables (handled elsewhere)."""
    out, last = [], 0
    for m in TOKEN_RE.finditer(xml):
        out.append(xml[last:m.start()]); last = m.end()
        if m.group(1):                 # table — untouched here
            out.append(m.group(1))
        else:                          # top-level paragraph
            cleaned = strip_grey_paragraph(m.group(2))
            if cleaned is not None:
                out.append(cleaned)
    out.append(xml[last:])
    return "".join(out)

def fill_slot(p, text):
    """Fill a paragraph in place with `text`, preserving its native paragraph
    properties (spacing/indent/style). Uses a bare run so the text inherits the
    paragraph's own font — no synthesized formatting, so output stays consistent
    with the rest of the template."""
    open_tag = re.match(r"^<w:p\b[^>]*>", p)
    open_tag = open_tag.group(0) if open_tag else "<w:p>"
    ppr = re.search(r"<w:pPr>.*?</w:pPr>", p, re.DOTALL)
    ppr_xml = ppr.group(0) if ppr else ""
    return f'{open_tag}{ppr_xml}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

# ── paragraph-section rules ───────────────────────────────────────────────────
# heading text (lower, normalized) -> placeholder that FILLS the next paragraph
# (the template's empty fill-in slot), in place, preserving its formatting.
HEADING_FILL = {
    "deskripsi perubahan":               "{deskripsi}",
    "tujuan dari perubahan":             "{tujuan}",
    "siapa dan sistem yang terpengaruh": "{sistem_terpengaruh}",
    "alasan pengecualian pengujian":     "{alasan_pengecualian}",
    "compensating control":              "{compensating_control}",
}

def process_paragraph(p, state):
    """Returns (replacement_xml, extra_xml_after)."""
    txt = stripped(p).lower()

    # 1) We're waiting to fill the slot right after a heading/label.
    if state.get("await"):
        ph = state.pop("await")
        return fill_slot(p, ph), ""

    # 2) Heading -> fill the NEXT paragraph (the empty slot) in place.
    for head, ph in HEADING_FILL.items():
        if txt == head or txt.startswith(head):
            state["await"] = ph
            return p, ""

    # 3) Inline replacements on label paragraphs. These rules match by TEXT
    # CONTENT across the whole document (unlike the await-fill mechanism
    # above, which only ever claims the one paragraph right after a known
    # heading) — so a grey example line whose wording happens to echo a real
    # label (the schedule section's example "Hari : Sabtu Tanggal : ..." vs.
    # the real "Hari : Tanggal :"; a reference note starting "Klasifikasi
    # Perubahan: ..."; an unrelated instruction that happens to mention
    # "mitigasi risiko") would otherwise ALSO get rewritten here, producing a
    # duplicate filled line alongside the real slot. Skip grey paragraphs
    # entirely — strip_grey() removes them afterward as usual.
    if _paragraph_is_grey(p):
        return p, ""

    if "hari" in txt and "tanggal" in txt:
        return set_para_text(p, "Hari: {jadwal_hari}     Tanggal: {jadwal_tanggal}"), ""
    if txt.startswith("jam"):
        return set_para_text(p, "Jam: {jadwal_jam}"), ""
    if "estimasi" in txt and "downtime" not in txt:
        return set_para_text(p, "Lama estimasi pengerjaan: {jadwal_estimasi}"), ""
    if "downtime" in txt:
        return set_para_text(p, "Estimasi downtime: {jadwal_downtime}"), ""
    if "layanan pulih" in txt or "layanan bisa digunakan" in txt:
        return set_para_text(p, "Layanan pulih pada: {jadwal_pulih}"), ""
    if txt.startswith("klasifikasi perubahan"):
        return set_para_text(p, "Klasifikasi Perubahan: {klasifikasi}"), ""
    if "mitigasi risiko" in txt:
        state["await"] = "{mitigasi}"   # fill the slot after the label
        return p, ""

    return p, ""

# ── table classifier ──────────────────────────────────────────────────────────

def header_text(tbl_xml):
    rs = rows_of(tbl_xml)
    return [stripped(c).lower() for c in cells_of(rs[0])] if rs else []

def all_text(tbl_xml):
    return stripped(tbl_xml).lower()

def process_table(tbl_xml, counters, sec_collector):
    hdr = header_text(tbl_xml)
    hjoined = " ".join(hdr)
    body = all_text(tbl_xml)
    rs = rows_of(tbl_xml)

    # RISK register -> single loop row
    if "likelihood" in hjoined and "impact" in hjoined:
        lr = loop_row([
            ("{no}",         "{#risks}", None),
            ("{risiko}",     None,       None),
            ("{likelihood}", None,       None),
            ("{impact}",     None,       None),
            ("{risk_level}", None,       "{/risks}"),
        ])
        return rebuild_table(tbl_xml, [rs[0], lr])

    # SECURITY requirements -> per-row {sec_N} in the last column
    if "requirement" in hjoined and "pemenuhan" in hjoined:
        out = [rs[0]]
        for r in rs[1:]:
            cs = cells_of(r)
            if len(cs) >= 3:
                counters["sec"] += 1
                n = counters["sec"]
                sec_collector.append(n)
                # Capture the requirement wording so we can flag text drift vs the frontend.
                counters.setdefault("sec_texts", []).append((n, stripped(cs[1])))
                cs[-1] = set_cell_text(cs[-1], f"{{sec_{n}}}")
                out.append(f"<w:tr>{row_pr(r)}{''.join(cs)}</w:tr>")
            else:
                out.append(r)
        return rebuild_table(tbl_xml, out)

    # TASK / ROLLBACK -> phase-grouped nested loop. First such table = tasks,
    # second = rollback. Each phase renders a grey merged header row followed by
    # its item rows:  {#task_groups}[header {group_label}] {#items}rows{/items}{/task_groups}
    if hdr[:3] == ["waktu", "pengerjaan", "pic"]:
        counters["wpp"] += 1
        g = "task_groups" if counters["wpp"] == 1 else "rollback_groups"
        header = group_header_row(f"{{#{g}}}{{group_label}}")
        items = loop_row([
            ("{waktu}",      "{#items}", None),
            ("{pengerjaan}", None,        None),
            ("{pic}",        None,        f"{{/items}}{{/{g}}}"),
        ])
        return rebuild_table(tbl_xml, [rs[0], header, items])

    # SIGN-OFF tables ("disusun oleh" / "disetujui oleh") pass through untouched;
    # make_signoff_dynamic replaces them wholesale with the {@signoff} anchor.

    # Anything else (e.g. the static Klasifikasi reference table) — leave as-is.
    return tbl_xml

# ── page header (word/headerN.xml) ────────────────────────────────────────────
# The repeating header has label/colon cells (Nomor Dokumen : | Tanggal : | ...)
# with empty values. Inject placeholders into the value side of each label.
HEADER_FIELDS = [
    "nomor_dokumen", "tanggal_permintaan", "nama_proyek",
    "target_penyelesaian", "departemen", "urgensi", "nama_pemohon",
]

def append_to_cell(cell, text):
    """Insert a run with `text` just before the end of the cell's last paragraph.

    The label cells this is used on already end in "Label: " (colon + trailing
    space) — no extra leading space here, or the rendered form shows "Label:  value".
    """
    idx = cell.rfind("</w:p>")
    if idx == -1:
        return set_cell_text(cell, text)
    return cell[:idx] + text_run(text) + cell[idx:]

def process_header(hx):
    m = re.search(r"<w:tbl>.*?</w:tbl>", hx, re.DOTALL)
    if not m:
        return hx
    tbl = m.group(0)
    rows = rows_of(tbl)
    new_rows = []
    for r in rows:
        cs = cells_of(r)
        lab0 = stripped(cs[0]).lower() if cs else ""
        if "nomor dokumen" in lab0 and len(cs) >= 2:
            cs[1] = append_to_cell(cs[1], "{nomor_dokumen}")
            if len(cs) >= 4: cs[3] = append_to_cell(cs[3], "{tanggal_permintaan}")
        elif "nama proyek" in lab0 and len(cs) >= 2:
            cs[1] = append_to_cell(cs[1], "{nama_proyek}")
            if len(cs) >= 4: cs[3] = append_to_cell(cs[3], "{target_penyelesaian}")
        elif "departemen" in lab0 and len(cs) >= 2:
            cs[1] = append_to_cell(cs[1], "{departemen}")
            if len(cs) >= 3: cs[2] = set_cell_text(cs[2], "Urgensi: {urgensi}")
        elif "nama pemohon" in lab0:
            # Value goes in cell[1] (right after the colon), matching how the
            # Departemen row places its value. cell[2] is the far-right column
            # (where Urgency sits on the row above) — putting the name there
            # would render it under Urgency, not next to the label.
            if len(cs) >= 2: cs[1] = append_to_cell(cs[1], "{nama_pemohon}")
        else:
            new_rows.append(r); continue
        new_rows.append(f"<w:tr>{row_pr(r)}{''.join(cs)}</w:tr>")
    new_tbl = tbl_prefix(tbl) + "".join(new_rows) + "</w:tbl>"
    return hx[:m.start()] + new_tbl + hx[m.end():]

# ── main pipeline ──────────────────────────────────────────────────────────────

TOKEN_RE = re.compile(r"(<w:tbl>.*?</w:tbl>)|(<w:p[ >].*?</w:p>)", re.DOTALL)

def inject(xml):
    counters = {"sec": 0, "wpp": 0}
    sec_collector = []
    state = {}
    out = []
    last = 0
    for m in TOKEN_RE.finditer(xml):
        out.append(xml[last:m.start()])        # non-token text in between
        last = m.end()
        if m.group(1):                         # a table
            out.append(process_table(m.group(1), counters, sec_collector))
        else:                                  # a top-level paragraph
            repl, extra = process_paragraph(m.group(2), state)
            out.append(repl)
            out.append(extra)
    out.append(xml[last:])
    # Slots are now filled in place; strip any leftover grey example paragraphs.
    result = strip_grey("".join(out))
    return result, sec_collector, counters.get("sec_texts", [])

EXPECTED_BASE = [
    "{deskripsi}", "{tujuan}",
    "{jadwal_hari}", "{jadwal_tanggal}", "{jadwal_jam}", "{jadwal_estimasi}",
    "{jadwal_downtime}", "{jadwal_pulih}",
    "{sistem_terpengaruh}",
    "{#risks}", "{risiko}", "{likelihood}", "{impact}", "{risk_level}", "{/risks}",
    "{mitigasi}", "{klasifikasi}",
    "{#task_groups}", "{group_label}", "{#items}", "{waktu}", "{pengerjaan}", "{pic}", "{/items}", "{/task_groups}",
    "{#rollback_groups}", "{/rollback_groups}",
    "{alasan_pengecualian}", "{compensating_control}",
    # Sign-off: single raw-XML anchor — the signature-box tables are built at
    # render time by backend/signoff-xml.js.
    "{@signoff}",
]

def verify(xml, sec_collector):
    expected = list(EXPECTED_BASE) + [f"{{sec_{n}}}" for n in sec_collector]
    missing = [p for p in expected if p not in xml]
    return expected, missing

def try_render(path):
    """Best-effort smoke test: render the template with dummy data via Node."""
    import subprocess, json, tempfile, textwrap
    data = {k.strip("{}#/@"): "x" for k in EXPECTED_BASE}
    data["risks"] = [{"no":"1","risiko":"x","likelihood":"Low","impact":"Low","risk_level":"Low"}]
    data["task_groups"] = [{"group_label":"x","items":[{"waktu":"x","pengerjaan":"x","pic":"x"}]}]
    data["rollback_groups"] = [{"group_label":"x","items":[{"waktu":"x","pengerjaan":"x","pic":"x"}]}]
    # {@signoff} splices its value into the document as raw OOXML — a plain
    # string like "x" would corrupt the XML, so feed it an empty paragraph.
    data["signoff"] = "<w:p/>"
    script = textwrap.dedent(f"""
        import PizZip from 'pizzip';
        import Docxtemplater from 'docxtemplater';
        import fs from 'node:fs';
        const zip = new PizZip(fs.readFileSync({json.dumps(path)}, 'binary'));
        const doc = new Docxtemplater(zip, {{ paragraphLoop: true, linebreaks: true }});
        doc.render({json.dumps(data)});
        console.log('render-ok', doc.getZip().generate({{type:'nodebuffer'}}).length);
    """)
    backend = os.path.join(ROOT, "apps", "rfc", "backend")
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", dir=backend, delete=False) as f:
        f.write(script); tmp = f.name
    try:
        r = subprocess.run(["node", tmp], cwd=backend, capture_output=True, text=True, timeout=60)
        ok = "render-ok" in r.stdout
        return ok, (r.stdout + r.stderr).strip()
    except Exception as e:
        return None, str(e)        # None = couldn't run (node missing etc.)
    finally:
        os.unlink(tmp)

def main():
    ap = argparse.ArgumentParser(description="Inject docxtemplater placeholders into an RFC template.")
    ap.add_argument("source", nargs="?", help="Path to the new .docx template")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT, help=f"Output path (default: {DEFAULT_OUT})")
    ap.add_argument("--check", metavar="DOCX", help="Verify an existing prepared template instead of building")
    ap.add_argument("--no-render", action="store_true", help="Skip the Node render smoke test")
    args = ap.parse_args()

    if args.check:
        with zipfile.ZipFile(args.check) as z:
            xml = z.read("word/document.xml").decode("utf-8")
        sec = sorted(int(m) for m in re.findall(r"\{sec_(\d+)\}", xml))
        expected, missing = verify(xml, sec)
        print(f"Checked {args.check}")
        print(f"  {len(expected)-len(missing)}/{len(expected)} placeholders present")
        if missing: print("  MISSING:", ", ".join(missing)); sys.exit(1)
        print("  ✓ all placeholders present"); return

    if not args.source:
        ap.error("provide a source .docx (or use --check)")
    if not os.path.exists(args.source):
        ap.error(f"file not found: {args.source}")

    with zipfile.ZipFile(args.source) as z:
        files = {n: z.read(n) for n in z.namelist()}
        xml = files["word/document.xml"].decode("utf-8")

    sec_texts = []
    if "{deskripsi}" in xml:
        print("⚠  This document already contains placeholders — copying as-is.")
        new_xml, sec = xml, sorted(int(m) for m in re.findall(r"\{sec_(\d+)\}", xml))
    else:
        new_xml, sec, sec_texts = inject(xml)

    # Replace the fixed sign-off tables with the {@signoff} raw-XML anchor
    # (apply_signoff.py); the backend builds the signature-box tables at render
    # time so the signatory count is dynamic while keeping the official
    # horizontal layout. Done before verify() so the anchor is present when we
    # check.
    if "{@signoff}" not in new_xml:
        new_xml = make_signoff_dynamic(new_xml)
        print("Sign-off: replaced with the render-time {@signoff} anchor.")

    expected, missing = verify(new_xml, sec)
    print(f"Placeholders: {len(expected)-len(missing)}/{len(expected)} found"
          + (f"  (security rows: {len(sec)})" if sec else ""))
    if missing:
        print("✗ MISSING:", ", ".join(missing))
        print("  The template's structure changed in a way these rules don't cover.")
        print("  Edit tools/apply_template.py (SECTIONS / table classifier) and re-run.")
        sys.exit(1)
    if len(sec) != 7:
        print(f"⚠  Found {len(sec)} security rows (expected 7). "
              f"Update SEC_REQUIREMENTS in apps/rfc/rfc-schema.js to match.")
    if sec_texts:
        # The .docx text comes from the template, but SEC_REQUIREMENTS in
        # apps/rfc/rfc-schema.js is the app-side authority — print the wording
        # so you can spot text-only drift (a row reworded without changing
        # the count).
        print("Security requirement wording (verify it matches SEC_REQUIREMENTS "
              "in apps/rfc/rfc-schema.js):")
        for n, text in sec_texts:
            print(f"  {n}. {text}")

    files["word/document.xml"] = new_xml.encode("utf-8")

    # Inject the repeating page header (Nomor Dokumen / Nama Proyek / Urgensi / …).
    header_done = []
    for name in list(files):
        if re.search(r"word/header\d+\.xml", name):
            htxt = files[name].decode("utf-8")
            if "{nomor_dokumen}" not in htxt:
                htxt = process_header(htxt)
                files[name] = htxt.encode("utf-8")
            header_done = [f"{{{k}}}" for k in HEADER_FIELDS if "{" + k + "}" in htxt]
    if header_done:
        print(f"Header fields: {len(header_done)}/{len(HEADER_FIELDS)} injected "
              f"({', '.join(header_done)})")
    else:
        print("⚠  No page header found to inject (Nomor Dokumen / Nama Proyek will stay blank).")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for n, d in files.items():
            zout.writestr(n, d)
    with open(args.out, "wb") as f:
        f.write(buf.getvalue())
    print(f"✓ Wrote {args.out}  ({os.path.getsize(args.out):,} bytes)")

    if not args.no_render:
        ok, msg = try_render(args.out)
        if ok is True:   print("✓ Render smoke test passed.")
        elif ok is False:print("✗ Render smoke test FAILED:\n" + msg); sys.exit(1)
        else:            print("•  Skipped render test (Node unavailable).")

if __name__ == "__main__":
    main()
