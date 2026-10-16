"""Weekly Earth Engine worker: fills requests made on the site's Satellite dataset catalog.
For each pending row in satellite_dataset_requests it computes yearly country values with Google Earth Engine
and writes them to observations (source 'SAT', indicator 'SAT.<DATASET CODE>').
Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EE_SERVICE_ACCOUNT_JSON (full JSON text), EE_PROJECT
Needs: pip install earthengine-api requests"""
import json, os, datetime, requests, ee

HERE = os.path.dirname(os.path.abspath(__file__))
DS = {d["code"]: d for d in json.load(open(os.path.join(HERE, "satellite_datasets.json")))}
SB, KEY = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HD = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal"}

def sb(method, table, params=None, body=None):
    r = requests.request(method, f"{SB}/rest/v1/{table}", headers=HD, params=params, json=body, timeout=120)
    if not r.ok: raise RuntimeError(f"{method} {table}: {r.status_code} {r.text[:200]}")
    return r.json() if method == "GET" else None

def year_image(d, y):
    col = ee.ImageCollection(d["collection"]).filterDate(f"{y}-01-01", f"{y + 1}-01-01").select(d["band"])
    if d.get("expr") == "water_permanent": img = col.first().eq(3)
    elif d["reduce"] == "sum": img = col.sum()
    else: img = col.mean()
    return img.multiply(d.get("scale", 1)).add(d.get("offset", 0)).rename("v")

def process(req):
    d = DS.get(req["dataset"])
    if not d: raise ValueError("unknown dataset " + req["dataset"])
    by_name = {c["name"]: c["iso"] for c in req["countries"]}
    gaul = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level0").filter(ee.Filter.inList("ADM0_NAME", list(by_name)))
    found = set(gaul.aggregate_array("ADM0_NAME").getInfo())
    missing = sorted(set(by_name) - found)
    y0, y1 = max(req["first_year"], d["first_year"]), min(req["last_year"], datetime.date.today().year - 1)
    code, obs = "SAT." + d["code"], []
    for y in range(y0, y1 + 1):
        feats = year_image(d, y).reduceRegions(collection=gaul, reducer=ee.Reducer.mean(), scale=d["resolution_m"], tileScale=4).getInfo()["features"]
        for f in feats:
            v = f["properties"].get("mean")
            if v is not None: obs.append({"geo": by_name[f["properties"]["ADM0_NAME"]], "indicator": code, "year": y, "value": v, "source": "SAT"})
    if obs:
        isos = ",".join(sorted(set(o["geo"] for o in obs)))
        sb("DELETE", "observations", {"indicator": f"eq.{code}", "source": "eq.SAT", "geo": f"in.({isos})"})
        for k in range(0, len(obs), 1000): sb("POST", "observations", body=obs[k:k + 1000])
        sb("DELETE", "indicators", {"source": "eq.SAT", "code": f"eq.{code}"})
        sb("POST", "indicators", body={"source": "SAT", "code": code, "name": d["name"], "unit": d["unit"], "theme": d["theme"]})
        vals = [o["value"] for o in sb("GET", "observations", {"indicator": f"eq.{code}", "select": "value", "limit": "100000"})]
        sb("DELETE", "indicator_ranges", {"indicator": f"eq.{code}"})
        sb("POST", "indicator_ranges", body={"indicator": code, "lo": min(vals), "hi": max(vals), "n_values": len(vals)})
    msg = f"{len(obs)} values for {len(found)} countries, {y0}-{y1}." + (" Not matched in the boundary file: " + ", ".join(missing) + "." if missing else "")
    return "done" if obs else "failed", msg

def main():
    cred = json.loads(os.environ["EE_SERVICE_ACCOUNT_JSON"])
    ee.Initialize(ee.ServiceAccountCredentials(cred["client_email"], key_data=json.dumps(cred)), project=os.environ["EE_PROJECT"])
    for req in sb("GET", "satellite_dataset_requests", {"status": "eq.pending", "order": "created_at", "limit": "20"}):
        try: st, msg = process(req)
        except Exception as e: st, msg = "failed", str(e)[:300]
        sb("PATCH", "satellite_dataset_requests", {"id": f"eq.{req['id']}"}, {"status": st, "message": msg})
        print(req["id"], req["dataset"], st, msg)

if __name__ == "__main__":
    main()
