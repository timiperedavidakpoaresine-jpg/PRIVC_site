"""Monthly import of a file-based provider (UNDP HDR or ITU DataHub) into Supabase.
Run by GitHub Actions (see .github/workflows/monthly-import.yml). Needs: pip install requests
Environment: PROVIDER (UNDP or ITU), FILE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
It writes observations / indicators / indicator_ranges with source = PROVIDER and code = PROVIDER.<code>."""
import csv, io, os, re, sys

HDRN = {"hdi": "Human Development Index (HDI)", "le": "Life expectancy at birth", "eys": "Expected years of schooling",
        "mys": "Mean years of schooling", "gnipc": "Gross national income per capita", "gdi": "Gender Development Index (GDI)",
        "ihdi": "Inequality-adjusted HDI (IHDI)", "gii": "Gender Inequality Index (GII)", "mmr": "Maternal mortality ratio",
        "abr": "Adolescent birth rate", "phdi": "Planetary pressures-adjusted HDI (PHDI)",
        "hdi_f": "Human Development Index, female", "hdi_m": "Human Development Index, male",
        "le_f": "Life expectancy at birth, female", "le_m": "Life expectancy at birth, male",
        "eys_f": "Expected years of schooling, female", "eys_m": "Expected years of schooling, male",
        "mys_f": "Mean years of schooling, female", "mys_m": "Mean years of schooling, male",
        "gnipc_f": "Estimated GNI per capita, female", "gnipc_m": "Estimated GNI per capita, male",
        "se_f": "Population with at least some secondary education, female (% ages 25 and older)",
        "se_m": "Population with at least some secondary education, male (% ages 25 and older)",
        "pr_f": "Share of seats in parliament, female (% held)", "pr_m": "Share of seats in parliament, male (% held)",
        "lfpr_f": "Labour force participation rate, female (% ages 15 and older)",
        "lfpr_m": "Labour force participation rate, male (% ages 15 and older)",
        "co2_prod": "Carbon dioxide emissions per capita (production), tonnes", "mf": "Material footprint per capita, tonnes",
        "ineq_edu": "Inequality in education (%)", "ineq_inc": "Inequality in income (%)", "ineq_le": "Inequality in life expectancy (%)",
        "coef_ineq": "Coefficient of human inequality"}
THEME = {"UNDP": "Human development", "ITU": "ICT"}
HDR_PAGE = "https://hdr.undp.org/data-center/documentation-and-downloads"

def discover_undp(requests):
    """Finds the newest 'composite indices complete time series' CSV on UNDP's download page, so no link has to be typed in."""
    import datetime
    from urllib.parse import urljoin
    found = []
    try:
        html = requests.get(HDR_PAGE, timeout=60, headers={"User-Agent": "PRIVC-Atlas/1.0"}).text
        for m in re.finditer(r'href=["\']([^"\']*Composite_indices_complete_time_series[^"\']*\.csv)["\']', html, re.I):
            u = urljoin(HDR_PAGE, m.group(1)); y = re.search(r"(20\d\d)", u); found.append((int(y.group(1)) if y else 0, u))
    except Exception as e:
        print("could not read the UNDP page:", e)
    if found: return sorted(found)[-1][1]
    yr = datetime.date.today().year          # fall back to the known file-name pattern, newest year first
    for y in (yr, yr - 1, yr - 2):
        u = f"https://hdr.undp.org/sites/default/files/{y}_HDR/HDR{y % 100}_Composite_indices_complete_time_series.csv"
        try:
            if requests.get(u, timeout=60, stream=True, headers={"User-Agent": "PRIVC-Atlas/1.0"}).status_code == 200: return u
        except Exception: pass
    raise RuntimeError("could not find the UNDP composite indices CSV; set UNDP_FILE_URL")

def find(H, pat):
    for i, h in enumerate(H):
        if re.match(pat, h): return i
    return -1

def parse(text):
    """Returns (rows, names): rows = {code: [(iso3, year, value), ...]}, names = {code: name}"""
    R = list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))
    if len(R) < 2: raise ValueError("empty file")
    H = [h.strip().lower() for h in R[0]]
    rows, names = {}, {}
    def add(code, nm, iso, y, v):
        try: v = float(v); y = int(y)
        except (TypeError, ValueError): return
        iso = (iso or "").strip().upper()
        if not code or not re.fullmatch(r"[A-Z]{3}", iso) or not 1900 < y < 2100: return
        rows.setdefault(code, []).append((iso, y, v))
        if nm and code not in names: names[code] = nm
    wide = [(i, m.group(1), int(m.group(2))) for i, h in enumerate(H) if (m := re.fullmatch(r"(.+)_(\d{4})", h))]
    iso3 = H.index("iso3") if "iso3" in H else -1
    if iso3 >= 0 and len(wide) >= 10:
        for r in R[1:]:
            for i, code, y in wide:
                if i < len(r): add(code, HDRN.get(code), r[iso3], y, r[i])
        return rows, {c: HDRN.get(c, c.upper() + " (HDR indicator code " + c + ")") for c in rows}
    ci = find(H, r"^(iso3?|iso3c|country_?code|economy_?code|ref_?area|geo|geo_?code|code)$")
    yi = find(H, r"^(year|time|time_?period|period)$")
    ki = find(H, r"^(indicator_?code|indicator_?id|series_?code|variable_?code)$")
    li = find(H, r"^(indicator|indicator_?name|series|series_?name|variable)$")
    vi = find(H, r"^(value|obs_?value|data|numeric_?value|obs_?val)$")
    yc = [(i, int(h)) for i, h in enumerate(H) if re.fullmatch(r"\d{4}", h)]
    if ci < 0 or (ki < 0 and li < 0): raise ValueError("unrecognised columns: " + ", ".join(H[:14]))
    for r in R[1:]:
        code = r[ki].strip() if ki >= 0 else re.sub(r"[^A-Za-z0-9_.]+", "_", r[li].strip())[:60]
        nm = r[li].strip() if li >= 0 else code
        if yi >= 0 and vi >= 0: add(code, nm, r[ci], r[yi], r[vi])
        else:
            for i, y in yc: add(code, nm, r[ci], y, r[i])
    if not rows: raise ValueError("no usable rows; columns: " + ", ".join(H[:14]))
    return rows, names

def main():
    import requests
    prov, url = os.environ["PROVIDER"].upper(), os.environ.get("FILE_URL", "").strip()
    if not url and prov == "UNDP": url = discover_undp(requests)
    if not url: print(prov, "has no FILE_URL set: nothing to do"); return
    print("downloading", url)
    sb, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    hd = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json", "Prefer": "return=minimal"}
    r = requests.get(url, timeout=300, headers={"User-Agent": "PRIVC-Atlas/1.0"}); r.raise_for_status()
    rows, names = parse(r.content.decode("utf-8-sig", errors="replace"))
    def call(method, table, params=None, body=None):
        x = requests.request(method, f"{sb}/rest/v1/{table}", headers=hd, params=params, json=body, timeout=120)
        if not x.ok: raise RuntimeError(f"{method} {table}: {x.status_code} {x.text[:200]}")
    for code, vals in rows.items():
        c = f"HDR.{code.upper()}" if prov == "UNDP" else f"{prov}.{code}"   # UNDP keeps the HDR.* codes your database already uses
        dedup = {(i, y): v for i, y, v in vals}            # one value per country and year
        obs = [{"geo": i, "indicator": c, "year": y, "value": v, "source": prov} for (i, y), v in dedup.items()]
        call("DELETE", "observations", {"source": f"eq.{prov}", "indicator": f"eq.{c}"})
        for k in range(0, len(obs), 1000): call("POST", "observations", body=obs[k:k + 1000])
        call("DELETE", "indicators", {"source": f"eq.{prov}", "code": f"eq.{c}"})
        call("POST", "indicators", body={"source": prov, "code": c, "name": names.get(code, code), "unit": None, "theme": THEME.get(prov)})
        vs = list(dedup.values())
        call("DELETE", "indicator_ranges", {"indicator": f"eq.{c}"})
        call("POST", "indicator_ranges", body={"indicator": c, "lo": min(vs), "hi": max(vs), "n_values": len(vs)})
        print("imported", c, len(obs))

if __name__ == "__main__":
    main()
