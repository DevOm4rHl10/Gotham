"""Turn crime records into the small static JSON files the site reads.

site/data/
  meta.json               months, totals, weights, coverage, quality metrics
  district.json           national view: every 1.6 km hex, whole period
  months/YYYY-MM.json     national view per month (for the time scrubber)
  zones.json              ranked hotspots (connected significant 400 m hexes)
  detail/index.json       list of 25 km tiles that have data
  detail/<cx>_<cy>.json   street view: 400 m hexes with category + monthly detail
"""
import json
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import grid, stats
from .config import (CATEGORIES, CHUNK_METRES, COVERAGE_ANCHORS, DETAIL_SIZE,
                     DISTRICT_SIZE, FDR, KNOWN_FORCES,
                     MAX_ZONE_CELLS)

CAT_SLUGS = list(CATEGORIES)
BREAK_QUANTILES = [0.35, 0.6, 0.78, 0.9, 0.96, 0.99]
CAT_INDEX = {s: i for i, s in enumerate(CAT_SLUGS)}


def _write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))


def _r(v, nd=1):
    return round(float(v), nd)


def prepare(df):
    """Add weight, projected coords and cell ids. Projects unique points only."""
    df = df.copy()
    df["weight"] = df["category"].map({s: w for s, (_, w) in CATEGORIES.items()}).fillna(0.0)
    df["cat"] = df["category"].map(CAT_INDEX).astype(np.int16)
    # Police data is snapped to a fixed set of anonymous map points, so there
    # are far fewer unique coordinates than crimes. Project each once.
    pts, inverse = np.unique(df[["lat", "lng"]].to_numpy(), axis=0, return_inverse=True)
    x, y = grid.project(pts[:, 0], pts[:, 1])
    for name, size in (("d", DISTRICT_SIZE), ("s", DETAIL_SIZE)):
        q, r = grid.to_cell(x, y, size)
        df[f"{name}q"] = q[inverse.ravel()]
        df[f"{name}r"] = r[inverse.ravel()]
    return df


def _hotspots(cells, value_col):
    """Gi* on a per-cell table. Returns table with z and sig (observed cells only)."""
    aq, ar, _, z, observed = stats.gi_star(cells["q"].to_numpy(), cells["r"].to_numpy(),
                                           cells[value_col].to_numpy())
    sig = stats.hot_significant(z, FDR)
    zt = pd.DataFrame({"q": aq[observed], "r": ar[observed], "z": z[observed], "sig": sig[observed]})
    return cells.merge(zt, on=["q", "r"], how="left")


def _per_cell(df, prefix):
    g = df.groupby([f"{prefix}q", f"{prefix}r"])
    out = g.agg(score=("weight", "sum"),
                crimes=("weight", lambda w: int((w > 0).sum())),
                asb=("weight", lambda w: int((w == 0).sum()))).reset_index()
    return out.rename(columns={f"{prefix}q": "q", f"{prefix}r": "r"})


def _top_cat(df, prefix):
    """Category contributing most harm per cell."""
    t = (df[df["weight"] > 0].groupby([f"{prefix}q", f"{prefix}r", "cat"])["weight"].sum()
         .reset_index().sort_values("weight").drop_duplicates([f"{prefix}q", f"{prefix}r"], keep="last"))
    return t.rename(columns={f"{prefix}q": "q", f"{prefix}r": "r", "cat": "top"})[["q", "r", "top"]]


def build(df, out, demo=False):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    df = prepare(df)
    months = sorted(df["month"].unique())
    print(f"{len(df):,} records, {len(months)} months, {df[['lat', 'lng']].drop_duplicates().shape[0]:,} map points")

    # ---- national view, whole period
    district = _hotspots(_per_cell(df, "d"), "score").merge(_top_cat(df, "d"), on=["q", "r"], how="left")
    district["top"] = district["top"].fillna(-1).astype(int)
    _write(out / "district.json", {
        "size": DISTRICT_SIZE,
        "cells": [[int(q), int(r), _r(s), int(c), _r(z, 2), int(sig), int(t)]
                  for q, r, s, c, z, sig, t in district[["q", "r", "score", "crimes", "z", "sig", "top"]]
                  .itertuples(index=False)],
    })

    # ---- national view, per month
    month_totals = []
    for m in months:
        cells = _hotspots(_per_cell(df[df["month"] == m], "d"), "score")
        _write(out / "months" / f"{m}.json", {
            "size": DISTRICT_SIZE,
            "cells": [[int(q), int(r), _r(s), int(sig)] for q, r, s, sig in
                      cells[["q", "r", "score", "sig"]].itertuples(index=False)],
        })
        month_totals.append({"month": m, "score": _r(cells["score"].sum(), 0),
                             "crimes": int(cells["crimes"].sum()), "asb": int(cells["asb"].sum())})

    # ---- street view, whole period, with stability across months
    detail = _hotspots(_per_cell(df, "s"), "score")
    monthly_sig = []
    for m in months:
        cm = _hotspots(_per_cell(df[df["month"] == m], "s"), "score")
        monthly_sig.append(set(zip(cm.loc[cm["sig"], "q"], cm.loc[cm["sig"], "r"])))
    stability = [stats.jaccard(a, b) for a, b in zip(monthly_sig, monthly_sig[1:])]

    cat_counts = (df.groupby(["sq", "sr", "cat"]).size().rename("n").reset_index())
    cats_by_cell = defaultdict(list)
    for q, r, c, n in cat_counts.itertuples(index=False):
        cats_by_cell[(q, r)].append([int(c), int(n)])
    month_idx = {m: i for i, m in enumerate(months)}
    by_month = df.groupby(["sq", "sr", "month"])["weight"].sum()
    trend_by_cell = defaultdict(lambda: [0.0] * len(months))
    for (q, r, m), v in by_month.items():
        trend_by_cell[(q, r)][month_idx[m]] = _r(v)

    cx, cy = grid.cell_center(detail["q"], detail["r"], DETAIL_SIZE)
    detail["chunk"] = [f"{a}_{b}" for a, b in zip(np.floor(cx / CHUNK_METRES).astype(int),
                                                  np.floor(cy / CHUNK_METRES).astype(int))]
    for chunk, part in detail.groupby("chunk"):
        _write(out / "detail" / f"{chunk}.json", {
            "size": DETAIL_SIZE,
            "cells": [[int(q), int(r), _r(s), int(c), _r(z, 2), int(sig),
                       cats_by_cell[(q, r)], trend_by_cell[(q, r)]]
                      for q, r, s, c, z, sig in part[["q", "r", "score", "crimes", "z", "sig"]]
                      .itertuples(index=False)],
        })
    _write(out / "detail" / "index.json", {"chunk": CHUNK_METRES, "tiles": sorted(detail["chunk"].unique())})

    # ---- hotspot zones: connected significant street-level cells
    hot = detail[detail["sig"]].reset_index(drop=True)
    zones = []
    if len(hot):
        hot["zone"] = stats.split_zones(hot["q"].to_numpy(), hot["r"].to_numpy(),
                                        hot["score"].to_numpy(), MAX_ZONE_CELLS)
        hot = hot[hot["zone"] >= 0]
        in_zone = df.merge(hot[["q", "r", "zone"]], left_on=["sq", "sr"], right_on=["q", "r"])
        place_of = (in_zone[in_zone["place"] != ""].groupby(["sq", "sr"])["place"]
                    .agg(lambda s: Counter(s).most_common(1)[0][0]))
        subs = dict(tuple(in_zone.groupby("zone")))
        for zid, part in hot.groupby("zone"):
            cells = list(zip(part["q"], part["r"]))
            sub = subs[zid]
            harm_by_cat = sub[sub["weight"] > 0].groupby("cat")["weight"].sum().sort_values(ascending=False)
            peak = part.loc[part["score"].idxmax()]
            name = place_of.get((peak["q"], peak["r"]), "") or "Unnamed area"
            cxz, cyz = grid.cell_center(part["q"], part["r"], DETAIL_SIZE)
            lat, lng = grid.unproject(cxz.mean(), cyz.mean())
            zones.append({
                "name": name,
                "score": _r(part["score"].sum(), 0),
                "crimes": int(part["crimes"].sum()),
                "area": _r(len(cells) * grid.cell_area_km2(DETAIL_SIZE), 2),
                "center": [_r(lat, 5), _r(lng, 5)],
                "cats": [[int(c), _r(100 * v / harm_by_cat.sum(), 0)] for c, v in harm_by_cat.head(3).items()],
                "force": Counter(sub["force"]).most_common(1)[0][0],
                "cells": [[int(q), int(r)] for q, r in cells],
            })
    zones.sort(key=lambda z: z["score"], reverse=True)
    _write(out / "zones.json", {"size": DETAIL_SIZE, "zones": zones[:100]})

    # ---- quality metrics and coverage
    scores = np.sort(detail["score"].to_numpy())[::-1]
    top1 = scores[: max(1, len(scores) // 100)].sum() / max(scores.sum(), 1e-9)
    present = Counter(df["force"])
    missing = [f for f in KNOWN_FORCES if f not in present]
    def breaks(cells, size):
        dens = cells.loc[cells["score"] > 0, "score"].to_numpy() / len(months) / grid.cell_area_km2(size)
        return [_r(v, 2) for v in np.quantile(dens, BREAK_QUANTILES)] if len(dens) else []

    _write(out / "meta.json", {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "demo": demo,
        "months": month_totals,
        "categories": [{"slug": s, "label": l, "weight": w} for s, (l, w) in CATEGORIES.items()],
        "grid": {"district": DISTRICT_SIZE, "detail": DETAIL_SIZE, "fdr": FDR},
        # colour class limits, in average monthly harm per km2, per resolution
        "breaks": {"district": breaks(district, DISTRICT_SIZE), "detail": breaks(detail, DETAIL_SIZE)},
        "quality": {
            "top1_share": _r(100 * top1, 1),
            "hotspot_cells": int(detail["sig"].sum()),
            "zones": len(zones),
            "stability": _r(float(np.mean(stability)) if stability else 1.0, 2),
        },
        "coverage": {
            "missing": [{"id": f, "name": KNOWN_FORCES[f], "at": COVERAGE_ANCHORS.get(f)} for f in missing],
            "forces": {f: KNOWN_FORCES.get(f, f) for f in sorted(present)},
        },
    })
    print(f"Wrote {out}: {len(district):,} district cells, {len(detail):,} street cells, "
          f"{len(zones)} hotspot zones, month-to-month stability {np.mean(stability) if stability else 1:.2f}")
