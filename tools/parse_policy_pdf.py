#!/usr/bin/env python3
"""
parse_policy_pdf.py — extract raw text from each Company IT Policy PDF in
policy/pdfs/, one JSON per PDF for backend/scripts/ingest-policy.js to chunk
and embed into Qdrant.

Unlike parse_pdf.py (structured RFC form fields), policy docs are long-form
prose — no field extraction, just clean page text joined with paragraph
breaks preserved.

Output: policy/parsed/<slug>.json = { source, title, text }. Re-runnable;
overwrites. To add another policy PDF: drop it in policy/pdfs/, rerun this.

Run:  python3 tools/parse_policy_pdf.py
"""
import json, re
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
SRC  = ROOT / "policy" / "pdfs"
OUT  = ROOT / "policy" / "parsed"


def slug(name):
    s = re.sub(r"\.pdf$", "", name, flags=re.I)
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s or "policy"


def extract_text(pdf_path):
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            t = (page.extract_text() or "").strip()
            if t:
                pages.append(t)
    return "\n\n".join(pages)


def main():
    if not SRC.exists():
        print(f"No {SRC} — nothing to parse. Drop policy PDFs there first.")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(SRC.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs in {SRC}.")
        return
    for pdf_path in pdfs:
        text = extract_text(pdf_path)
        if not text.strip():
            print(f"  ✗ {pdf_path.name} — no extractable text, skipped")
            continue
        record = {"source": pdf_path.name, "title": pdf_path.stem, "text": text}
        out_path = OUT / f"{slug(pdf_path.name)}.json"
        out_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  ✓ {pdf_path.name} → {out_path.relative_to(ROOT)} ({len(text)} chars)")


if __name__ == "__main__":
    main()
