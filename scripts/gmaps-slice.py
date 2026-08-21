#!/usr/bin/env python3
"""Slice the Google Maps US business dataset into an import-ready CSV.

The dataset is 13 independent zips (~480MB, ~12M rows) that ship with
growthenginenowoslawski/coldoutboundskills. It is FIRMOGRAPHIC data — business
name, website, phone, category, ZIP — and carries no email addresses and no
personal names.

That shape decides where it belongs. LeadRail's lead import requires an email
and dedupes on it (app/api/leads/import/route.ts), so importing these rows as
LEADS would skip every one of them. They are companies: the row maps onto the
`companies` table, and contacts are found afterwards by enriching the domain.

Nothing is ever imported wholesale. 12M rows is not a prospect list, it is a
haystack — the point is to pull the slice matching one ICP and enrich that.

Streams each member straight out of its zip, so the 1.8GB of CSV is never
written to disk.

Usage:
  python3 scripts/gmaps-slice.py --data DIR --category 'dentist|orthodont' \\
      --zip 900,901,902 --limit 5000 --out dentists-la.csv

  --data      directory holding google-maps-scrape-part*.zip
  --category  case-insensitive regex against the category field
  --zip       comma-separated ZIP prefixes (e.g. 90 matches all 90xxx)
  --require   comma-separated fields that must be non-empty (default: domain)
  --limit     stop after N matches (default 10000; 0 = no cap)
"""
import argparse, csv, io, re, sys, zipfile
from pathlib import Path

OUT_COLS = ['name', 'domain', 'website', 'industry', 'location', 'phone']


def clean_phone(v: str) -> str:
    # Stored as a float-ish string: "12027276436.0". The fractional part must be
    # dropped BEFORE stripping non-digits — otherwise the trailing ".0" becomes
    # a twelfth digit, the length check rejects it, and every phone silently
    # comes out empty. (It did.)
    v = (v or '').strip()
    if v.lower() in ('nan', 'none'):
        return ''
    v = v.split('.')[0]
    d = re.sub(r'\D', '', v)
    if len(d) == 11 and d.startswith('1'):
        d = d[1:]
    return d if len(d) == 10 else ''


def clean_category(v: str) -> str:
    # Stored as a Python list literal: "['3-star hotel', 'Hotel']".
    parts = re.findall(r"'([^']+)'", v or '')
    return ', '.join(parts) if parts else (v or '').strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--category', default='')
    ap.add_argument('--zip', default='')
    ap.add_argument('--require', default='domain')
    ap.add_argument('--limit', type=int, default=10000)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    cat_re = re.compile(a.category, re.I) if a.category else None
    zips = tuple(z.strip() for z in a.zip.split(',') if z.strip())
    required = [f.strip() for f in a.require.split(',') if f.strip()]

    parts = sorted(Path(a.data).glob('google-maps-scrape-part*.zip'),
                   key=lambda p: int(re.search(r'part(\d+)', p.name).group(1)))
    if not parts:
        print(f'no google-maps-scrape-part*.zip under {a.data}', file=sys.stderr)
        return 1

    seen_domains: set[str] = set()
    scanned = matched = 0
    with open(a.out, 'w', newline='', encoding='utf-8') as fout:
        w = csv.DictWriter(fout, fieldnames=OUT_COLS)
        w.writeheader()
        for part in parts:
            with zipfile.ZipFile(part) as z:
                member = z.namelist()[0]
                with z.open(member) as raw:
                    for row in csv.DictReader(io.TextIOWrapper(raw, 'utf-8', errors='replace')):
                        scanned += 1
                        cat = clean_category(row.get('category_titles', ''))
                        if cat_re and not cat_re.search(cat):
                            continue
                        zc = (row.get('zip_code') or '').strip()
                        if zips and not zc.startswith(zips):
                            continue
                        out = {
                            'name': (row.get('title') or '').strip(),
                            'domain': (row.get('normalized_display_link') or '').strip(),
                            'website': (row.get('link') or '').strip(),
                            'industry': cat,
                            'location': zc,
                            'phone': clean_phone(row.get('phone', '')),
                        }
                        if any(not out[f] for f in required):
                            continue
                        # One row per domain: the same business appears under
                        # several categories and across parts.
                        if out['domain']:
                            if out['domain'] in seen_domains:
                                continue
                            seen_domains.add(out['domain'])
                        w.writerow(out)
                        matched += 1
                        if a.limit and matched >= a.limit:
                            print(f'scanned {scanned:,} | matched {matched:,} (limit) -> {a.out}')
                            return 0
            print(f'  {part.name}: scanned {scanned:,}, matched {matched:,}', file=sys.stderr)
    print(f'scanned {scanned:,} | matched {matched:,} -> {a.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
