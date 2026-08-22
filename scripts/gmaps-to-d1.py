#!/usr/bin/env python3
"""Turn the 12M-row Google Maps dataset into D1-loadable SQL.

WHY A FILE AND NOT DIRECT INSERTS
D1's HTTP API takes one request at a time. At ~1,000 rows per request, 12.3M
rows is ~12,000 round trips, and the free tier allows 100,000 writes per DAY —
about 120 days. The supported path for bulk data is `wrangler d1 execute
--file`, which streams a SQL file server-side, so that is what this emits.

Use --limit / --category / --zip to cut a targeted slice small enough to push
through the API instead. That is the normal case: 12M rows is a haystack, and
what anyone actually wants is the few thousand matching one ICP.

Adds STATE and CITY by joining us-zip-codes.csv, which ships in the same folder.
The raw rows carry only a ZIP, and "dentists in California" is the query people
actually ask — without the join it cannot be answered.

Usage:
  python3 scripts/gmaps-to-d1.py --data DIR --out /tmp/biz.sql
  python3 scripts/gmaps-to-d1.py --data DIR --category 'dentist' --state CA \
      --limit 20000 --out /tmp/dentists-ca.sql

Then:
  wrangler d1 execute leadrail-businesses --remote --file=/tmp/biz.sql
"""
import argparse, csv, io, json, re, sys, zipfile
from pathlib import Path

BATCH = 500  # rows per INSERT statement — SQLite's compiled parameter ceiling

def load_verticals(repo_root: Path):
    """Ordered (name, compiled) pairs. Order matters: specific trades must be
    tested before the generic contractor/construction catch-alls, or a roofing
    contractor lands in `construction` and the per-vertical counts are wrong."""
    f = repo_root / 'lib' / 'verticals.json'
    if not f.exists():
        return []
    spec = json.loads(f.read_text(encoding='utf-8'))['verticals']
    return [(k, re.compile(v, re.I)) for k, v in spec.items()]


def classify(cat: str, verticals) -> str:
    for name, pat in verticals:
        if pat.search(cat):
            return name
    return ''



def clean_phone(v: str) -> str:
    # Stored as a float-ish string ("12027276436.0"). The fractional part must go
    # BEFORE stripping non-digits, or the trailing ".0" becomes a twelfth digit
    # and every phone silently comes out empty.
    v = (v or '').strip()
    if v.lower() in ('nan', 'none'):
        return ''
    d = re.sub(r'\D', '', v.split('.')[0])
    if len(d) == 11 and d.startswith('1'):
        d = d[1:]
    return d if len(d) == 10 else ''


def clean_category(v: str) -> str:
    parts = re.findall(r"'([^']+)'", v or '')
    return ', '.join(parts) if parts else (v or '').strip()


def sql_str(v: str) -> str:
    return "'" + (v or '').replace("'", "''") + "'"


def load_zips(data: Path) -> dict:
    """zip -> (state, city). The file lives beside the dataset."""
    out = {}
    for candidate in (data / 'us-zip-codes.csv', data.parent / 'us-zip-codes.csv'):
        if not candidate.exists():
            continue
        with open(candidate, newline='', encoding='utf-8', errors='replace') as f:
            for row in csv.DictReader(f):
                z = (row.get('zip') or '').strip().zfill(5)
                if z:
                    out[z] = ((row.get('state') or '').strip(), (row.get('primary_city') or '').strip())
        break
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--category', default='')
    ap.add_argument('--state', default='')
    ap.add_argument('--zip', default='')
    ap.add_argument('--require', default='')  # '' = keep every row, website or not
    ap.add_argument('--limit', type=int, default=0)
    # One .sql per input zip. A single 2GB file is a bad unit of work: wrangler
    # streams it as one transaction, so any failure loses the whole run and
    # there is no way to resume from the middle. Thirteen ~150MB files load
    # independently and a failure costs one part.
    ap.add_argument('--split', action='store_true')
    ap.add_argument('--dedupe-domain', action='store_true', help='one row per domain (loses multi-location businesses)')
    a = ap.parse_args()

    data = Path(a.data)
    verticals = load_verticals(Path(__file__).resolve().parent.parent)
    zips = load_zips(data)
    if not zips:
        print('warning: us-zip-codes.csv not found — state/city will be blank', file=sys.stderr)

    cat_re = re.compile(a.category, re.I) if a.category else None
    states = {s.strip().upper() for s in a.state.split(',') if s.strip()}
    zprefix = tuple(z.strip() for z in a.zip.split(',') if z.strip())
    required = [f.strip() for f in a.require.split(',') if f.strip()]

    parts = sorted(data.glob('google-maps-scrape-part*.zip'),
                   key=lambda p: int(re.search(r'part(\d+)', p.name).group(1)))
    if not parts:
        print(f'no google-maps-scrape-part*.zip under {data}', file=sys.stderr)
        return 1

    seen: set[str] = set()
    scanned = matched = 0
    pending: list[str] = []

    outdir = Path(a.out)
    if a.split:
        outdir.mkdir(parents=True, exist_ok=True)

    with open(a.out if not a.split else outdir / '_all.sql', 'w', encoding='utf-8') as fout:
        fout.write('PRAGMA defer_foreign_keys = true;\n')

        def flush():
            if not pending:
                return
            fout.write(
                'INSERT OR IGNORE INTO businesses (name,domain,website,phone,category,vertical,zip,state,country,source) VALUES\n'
                + ',\n'.join(pending) + ';\n')
            pending.clear()

        for part in parts:
            with zipfile.ZipFile(part) as z:
                with z.open(z.namelist()[0]) as raw:
                    for row in csv.DictReader(io.TextIOWrapper(raw, 'utf-8', errors='replace')):
                        scanned += 1
                        cat = clean_category(row.get('category_titles', ''))
                        if cat_re and not cat_re.search(cat):
                            continue
                        zc = (row.get('zip_code') or '').strip().zfill(5)
                        if zprefix and not zc.startswith(zprefix):
                            continue
                        st, _city = zips.get(zc, ('', ''))
                        if states and st.upper() not in states:
                            continue

                        rec = {
                            'name': (row.get('title') or '').strip()[:200],
                            'domain': (row.get('normalized_display_link') or '').strip()[:160],
                            'website': (row.get('link') or '').strip()[:400],
                            'phone': clean_phone(row.get('phone', '')),
                            'category': cat[:300],
                            'zip': zc,
                            'state': st,
                        }
                        if any(not rec[f] for f in required):
                            continue
                        # NO in-memory domain dedupe on the full load. A domain
                        # is not a business: every branch of a multi-site
                        # operator shares one, and dropping them loses a third
                        # of the dataset (part 1: 1,000,000 rows -> 670,232).
                        # The database index is non-unique for the same reason;
                        # collapsing to one row per domain is a QUERY concern
                        # (SELECT DISTINCT domain) and must not be baked into
                        # the load, which is irreversible.
                        if a.dedupe_domain and rec['domain']:
                            if rec['domain'] in seen:
                                continue
                            seen.add(rec['domain'])

                        pending.append('(' + ','.join([
                            sql_str(rec['name']), sql_str(rec['domain']), sql_str(rec['website']),
                            sql_str(rec['phone']), sql_str(rec['category']),
                            sql_str(classify(rec['category'], verticals)),
                            sql_str(rec['zip']), sql_str(rec['state']), "'US'", "'gmaps-12m'",
                        ]) + ')')
                        matched += 1
                        if len(pending) >= BATCH:
                            flush()
                        if a.limit and matched >= a.limit:
                            flush()
                            print(f'scanned {scanned:,} | rows {matched:,} (limit) -> {a.out}')
                            return 0
            print(f'  {part.name}: scanned {scanned:,}, matched {matched:,}', file=sys.stderr)
        flush()

    print(f'scanned {scanned:,} | rows {matched:,} -> {a.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
