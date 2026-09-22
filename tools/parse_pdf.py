#!/usr/bin/env python3
"""
parse_pdf.py — extract a structured RFC record from each signed PDF in RFC/.

Uses pdfplumber for text + table extraction. Designed to be ROBUST to template
drift across the 2025-2026 form versions: sections are found by lettered
heading + keyword (not exact strings), tables are classified by their header
row content, and every field is extracted defensively (one bad section never
aborts the whole file).

Output: RFC/imported/<ticket>.json per PDF, each carrying its source filename
(for the tracker join) and the parsed fields. Re-runnable; overwrites.

Run:  python3 tools/parse_pdf.py
"""
import json, os, re, sys, glob
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
SRC  = ROOT / "RFC"
OUT  = ROOT / "RFC" / "imported"

ID_MONTHS = {
    "januari": 1, "februari": 2, "maret": 3, "april": 4, "mei": 5, "juni": 6,
    "juli": 7, "agustus": 8, "september": 9, "oktober": 10, "november": 11, "desember": 12,
}


# ── helpers ────────────────────────────────────────────────────────────────
def clean(s):
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s)).strip()

def date_to_iso(s):
    """'10 Desember 2025' / '2025-12-10' / '2025-11-06 00:00:00' → '2025-12-10'."""
    if not s:
        return ""
    s = clean(str(s))
    m = re.match(r"r(\d{1,2})\s+([A-Za-zö]+)\s+(\d{4})", s) or re.match(r"(\d{1,2})\s+([A-Za-zö]+)\s+(\d{4})", s)
    if m:
        d, mon, y = int(m.group(1)), m.group(2).lower(), int(m.group(3))
        mo = ID_MONTHS.get(mon)
        if mo:
            return f"{y:04d}-{mo:02d}-{d:02d}"
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""

def split_bullets(s):
    """Bullet text ('● a\\nb' / '- a; b') → list of items."""
    if not s:
        return []
    parts = re.split(r"[\n;]|●|•|▪", str(s))
    return [re.sub(r"^\s*[-*]\s*", "", p).strip() for p in parts if p.strip()]

def slug_ticket(t):
    return re.sub(r"[^A-Za-z0-9]+", "-", str(t or "")).strip("-").lower() or "noticket"


# ── title (Nama Proyek) ─────────────────────────────────────────────────────
# Other header labels; anything after one of these bled in from a neighbour
# cell / column and is not part of the title.
HDR_LABELS = r"Nomor\s+Permintaan|Tanggal\s+Permintaan|Target\s+Penyelesaian|Departemen\s+Pemohon|Nama\s+Pemohon|Urgensi"

def title_from_header_table(page):
    """Page 1's header block is a table, and 'Nama Proyek' shares a cell with
    its (often multi-line) value. pdfplumber's extract_text() interleaves the
    vertically-centered label into the middle of the wrapped value and merges
    the right column ('Target Penyelesaian : …') onto the same lines, so any
    regex over the flattened text captures fragments of neighbouring cells.
    Read the cell itself instead: drop the label + colon, rejoin the wraps."""
    for tbl in page.extract_tables() or []:
        for row in tbl:
            for i, cell in enumerate(row):
                if not cell or not re.search(r"Nama\s+Proyek", cell):
                    continue
                val = clean(re.sub(r"Nama\s+Proyek", " ", cell)).lstrip(": ").strip()
                if not val:  # label-only cell → value lives in the next cell
                    rest = [clean(c) for c in row[i + 1:] if clean(c)]
                    val = rest[0].lstrip(": ").strip() if rest else ""
                val = re.split(HDR_LABELS, val)[0].strip(" :")
                if val:
                    return val
    return ""

def strip_form_boilerplate(t):
    """Some requesters type the form name into the Nama Proyek field ('Form
    Permintaan Perubahan - <actual title>'); drop that leading boilerplate."""
    t = clean(t or "")
    stripped = clean(re.sub(r"(?i)^(?:form(?:ulir)?\s+permintaan(?:\s+perubahan|\s+pembuatan)?\s*[-–:]*\s*)+", "", t))
    return stripped or t

def title_from_filename(path):
    """Last-resort title: the source PDF filename minus signing suffixes,
    leading dates/indexes and the form-name boilerplate — filenames in RFC/
    carry the real change title."""
    name = re.sub(r"\.pdf$", "", os.path.basename(path), flags=re.I)
    name = re.sub(r"_signe-\d+x", " ", name)
    name = re.sub(r"\(\d+\)", " ", name)
    name = clean(name)
    for _ in range(4):  # peel leading boilerplate one layer per pass
        prev = name
        name = re.sub(r"^(?:\d[\d\-/.]*|[-_:.])\s*", "", name)
        name = re.sub(r"(?i)^(?:RFC|Form(?:ulir)?(?:\s+Permintaan)?(?:\s+Perubahan|\s+Pembuatan)?)\b\s*", "", name)
        name = clean(name)
        if name == prev:
            break
    return name


# ── header block (ticket / dates / title / urgensi) ────────────────────────
def parse_header(text):
    h = {}
    t = text.replace("\n", " ")
    m = re.search(r"Nomor\s+Permintaan\s*:\s*([A-Z/0-9\-]+)", t)
    h["ticket"] = clean(m.group(1)) if m else ""
    m = re.search(r"Tanggal\s+Permintaan\s*:\s*([0-9A-Za-zö ]+?)(?=Nama\s+Proyek|Target|$)", t)
    h["tanggal_permintaan"] = date_to_iso(m.group(1)) if m else ""
    m = re.search(r"Target\s+Penyelesaian\s*:\s*([0-9A-Za-zö ]+?)(?=Departemen|Urgensi|$)", t)
    h["target_penyelesaian"] = date_to_iso(m.group(1)) if m else ""
    m = re.search(r"Nama\s+Proyek\s*:?\s*(.+?)\s+Target\s+Penyelesaian", t)
    h["nama_proyek"] = clean(m.group(1)) if m else ""
    m = re.search(r"Departemen\s+Pemohon\s*:\s*(.+?)\s+Urgensi", t)
    h["departemen"] = clean(m.group(1)) if m else ""
    m = re.search(r"Nama\s+Pemohon\s*:\s*([A-Za-z .,]+?)(?:High|Medium|Low|$)", t)
    h["nama_pemohon"] = clean(m.group(1)) if m else ""
    # urgensi: the checked level — text extraction lists all three; take the
    # one immediately following the name if discoverable, else leave blank.
    for lvl in ("Critical", "High", "Medium", "Low"):
        if re.search(rf"\b{lvl}\b", t) and lvl not in h.get("_urgensi_seen", []):
            h["urgensi"] = lvl
            break
    return h


# ── section prose (split full text by lettered heading markers) ────────────
HEADING_KEYS = [
    ("description",       r"DESKRIPSI"),
    ("tujuan",            r"TUJUAN"),
    ("sistem_terpengaruh", r"SIAPA|SISTEM YANG TERPENGARUH|DAMPAK"),
    ("jadwal",            r"JADWAL"),
    ("risiko",            r"RISIKO"),
    ("mitigasi",          r"MITIGASI"),
    ("tasklist",          r"TASKLIST|RENCANA|PENGERJAAN"),
    ("rollback",          r"ROLLBACK|PEMBATALAN"),
    ("security",          r"SECURITY"),
    ("pengecualian",      r"PENGECUALIAN"),
    ("compensating",      r"COMPENSATING"),
    ("lampiran",          r"LAMPIRAN"),
]

def slice_sections(text):
    """Return {section_key: text_between_this_heading_and_next}."""
    # find every lettered heading line:  "A. DESKRIPSI PERUBAHAN", "B. TUJUAN ..."
    # Label class is uppercase + space/slash ONLY (no \n) so the match can't
    # run on and swallow the first capital letter of the section body.
    marks = []
    for m in re.finditer(r"(?m)^\s*([A-Z])\.\s+([A-Z][A-Z /]{3,})", text):
        letter = m.group(1)
        label = m.group(2).strip()
        for key, pat in HEADING_KEYS:
            if re.search(pat, label):
                # use the full match end so the heading line is fully skipped
                marks.append((m.start(), m.end(), key, label))
                break
    sections = {}
    for i, (start, end, key, label) in enumerate(marks):
        nxt = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        sections[key] = text[end:nxt].strip()
    return sections

def parse_jadwal(sec):
    out = {}
    if not sec:
        return out
    t = sec.replace("\n", " ")
    m = re.search(r"Hari\s*:\s*([A-Za-z]+)", t);           out["jadwal_hari"] = clean(m.group(1)) if m else ""
    m = re.search(r"Tanggal\s*:\s*([0-9A-Za-zö ]+?)(?=Jam|Lama|$)", t)
    d = date_to_iso(m.group(1)) if m else ""
    out["jadwal_tanggal"] = d
    if d: out["execDate"] = d
    m = re.search(r"Jam\s*:\s*([0-9:\- ]+?)(?=Lama|$)", t); out["jadwal_jam"] = clean(m.group(1)) if m else ""
    m = re.search(r"Lama estimasi pengerjaan\s*:\s*(.+?)(?=[A-Z]\.|\Z)", t)
    out["jadwal_estimasi"] = clean(m.group(1)) if m else ""
    return out


def parse_risiko_section(sec, table_risks):
    """Inside section E (RISIKO): risks appear as a table OR as prose bullets
    under "Perkiraan risiko :", and mitigasi as bullets under "Mitigasi risiko :".
    Returns (prose_risks, mitigasi_text)."""
    if not sec:
        return [], ""
    # Mitigasi: text after the "Mitigasi risiko" label, cut at the repeating
    # page header ("Nomor Permintaan" / "FORM PERMINTAAN"), a new lettered
    # heading, or end.
    mitigasi = ""
    m = re.search(r"(?is)Mitigasi\s+risiko\s*:?\s*(.+?)(?:Nomor\s+Permintaan|FORM\s+PERMINTAAN|^([A-Z]\.\s)|\Z)", sec)
    if m:
        mitigasi = clean(m.group(1))
    # Prose risks: bullets under "Perkiraan risiko :" up to "Mitigasi" or a table
    # header ("No Risiko"). Only used when the table extractor found nothing.
    prose = []
    if not table_risks:
        m = re.search(r"(?is)Perkiraan\s+risiko\s*:?\s*(.+?)(?:Mitigasi\s+risiko|Nomor\s+Permintaan|FORM\s+PERMINTAAN|$)", sec)
        if m:
            blob = m.group(1)
            # skip if this is actually the table header (handled elsewhere)
            if not re.search(r"Risiko\s+Dampak|No\s+Risiko", blob):
                for item in split_bullets(blob):
                    # drop obvious non-risk lines (table fragments, page-header bleed)
                    if len(item) > 6 and not item.lower().startswith(("tinggi", "rendah", "sedang", "no ", "form ", "nomor ", "nama ")):
                        prose.append({"risiko": item, "likelihood": "", "impact": "", "risk_level": ""})
    return prose, mitigasi


# ── tables (risk / tasks / rollback / sec_requirements) ────────────────────
def classify_and_extract_tables(pages):
    """Walk every table on every page; classify by header row; collect."""
    risks, tasks, rollback, sec_req = [], [], [], []
    wp_pic_seen = 0  # 1st Waktu/Pengerjaan/PIC table → tasks, 2nd → rollback
    for page in pages:
        for tbl in page.extract_tables() or []:
            if not tbl or not tbl[0]:
                continue
            hdr = [clean(c).lower() for c in tbl[0]]
            joined = " ".join(hdr)
            # risk register: has "risiko"/"risk" + one of dampak/impact/kemungkinan/likelihood/tingkat
            if any("risiko" in h or "risk" in h or "perkiraan" in h for h in hdr) and \
               any(k in joined for k in ("dampak", "impact", "kemungkinan", "likelihood", "tingkat")):
                for r in tbl[1:]:
                    cells = [clean(c) for c in r]
                    if not any(cells):
                        continue
                    risks.append({
                        "risiko": cells[1] if len(cells) > 1 else "",
                        "likelihood": _nth_or(cells, ["likelihood", "kemungkinan"], hdr),
                        "impact":     _nth_or(cells, ["impact", "dampak"], hdr),
                        "risk_level": _nth_or(cells, ["tingkat", "risk level", "risk_level"], hdr),
                    })
            # Waktu / Pengerjaan / PIC — 1st occurrence = tasks, 2nd = rollback
            elif any("waktu" in h for h in hdr) and any("pengerjaan" in h for h in hdr):
                wp_pic_seen += 1
                target = tasks if wp_pic_seen == 1 else rollback
                for r in tbl[1:]:
                    cells = [clean(c) for c in r]
                    if not any(cells):
                        continue
                    target.append({
                        "waktu": cells[0] if len(cells) > 0 else "",
                        "pengerjaan": cells[1] if len(cells) > 1 else "",
                        "pic": cells[2] if len(cells) > 2 else "",
                    })
            # security requirements: header mentions requirement + pemenuhan
            elif "requirement" in joined and "pemenuhan" in joined:
                for r in tbl[1:]:
                    cells = [clean(c) for c in r]
                    if not any(cells):
                        continue
                    val = cells[-1] if cells else ""   # pemenuhan is the last col
                    status, reason = val, ""
                    if "—" in val or " - " in val:
                        parts = re.split(r"—|\s-\s", val, 1)
                        status, reason = parts[0].strip(), parts[1].strip() if len(parts) > 1 else ""
                    sec_req.append({"status": status, "reason": reason})
    return risks, tasks, rollback, sec_req

def _nth_or(cells, keys, hdr):
    """Value from `cells` at the first column whose header matches any of `keys`."""
    for i, h in enumerate(hdr):
        if any(k in h for k in keys) and i < len(cells):
            return cells[i]
    return ""


# ── per-file driver ─────────────────────────────────────────────────────────
def parse_one(path):
    with pdfplumber.open(path) as pdf:
        full = "\n".join((p.extract_text() or "") for p in pdf.pages)
        header = parse_header(full)
        sections = slice_sections(full)
        risks, tasks, rollback, sec_req = classify_and_extract_tables(pdf.pages)
        prose_risks, mitigasi = parse_risiko_section(sections.get("risiko", ""), risks)
        if prose_risks:
            risks = prose_risks
        title = title_from_header_table(pdf.pages[0]) if pdf.pages else ""

    if not title:
        # regex fallback is only trustworthy when no neighbour-cell label bled in
        title = header.get("nama_proyek", "")
        if re.search(HDR_LABELS, title):
            title = ""
    rec = {
        "source_file": os.path.basename(path),
        "ticket": header.get("ticket", ""),
        "title": strip_form_boilerplate(title) or title_from_filename(path),
        "tanggal_permintaan": header.get("tanggal_permintaan", ""),
        "target_penyelesaian": header.get("target_penyelesaian", ""),
        "departemen": header.get("departemen", ""),
        "executor": header.get("nama_pemohon", ""),
        "urgensi": header.get("urgensi", ""),
        "description": clean(sections.get("description", "")),
        "tujuan": clean(sections.get("tujuan", "")),
        "sistem_terpengaruh": sections.get("sistem_terpengaruh", "").strip(),
        "mitigasi": mitigasi or clean(sections.get("mitigasi", "")),
        "alasan_pengecualian": sections.get("pengecualian", "").strip(),
        "compensating_control": sections.get("compensating", "").strip(),
        "risks": risks,
        "tasks": tasks,
        "rollback": rollback,
        "sec_requirements": sec_req,
        "klasifikasi": _klasifikasi(full),
    }
    rec["jadwal_hari"] = parse_jadwal(sections.get("jadwal", "")).get("jadwal_hari", "")
    jd = parse_jadwal(sections.get("jadwal", ""))
    rec.update({k: jd.get(k, "") for k in ("jadwal_jam", "jadwal_estimasi", "execDate")})
    return rec

def _klasifikasi(text):
    t = text.replace("\n", " ")
    m = re.search(r"Klasifikasi\s+Perubahan\s*:?\s*(Mayor|Major|Minor)", t, re.I)
    if m:
        return "Major" if m.group(1).lower().startswith("may") else "Minor"
    return ""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(glob.glob(str(SRC / "*.pdf")))
    if not pdfs:
        print(f"no PDFs in {SRC}", file=sys.stderr); sys.exit(1)
    n_ok = n_err = 0
    for p in pdfs:
        try:
            rec = parse_one(p)
            (OUT / f"{slug_ticket(rec['ticket']) or slug_ticket(rec['source_file'])}.json").write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            n_ok += 1
        except Exception as e:
            print(f"  ✗ {os.path.basename(p)}: {e}", file=sys.stderr)
            n_err += 1
    print(f"parsed {n_ok} PDF(s) OK, {n_err} error(s) → {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
