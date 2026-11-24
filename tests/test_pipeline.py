import json

import numpy as np
import pytest

from pipeline import grid, stats
from pipeline.build import build
from pipeline.ingest import load_archive
from synthetic import make_zip


def test_projection_round_trip():
    lat = np.array([50.06, 51.5, 54.6, 58.97])
    lng = np.array([-5.71, -0.13, -5.93, -3.0])
    back_lat, back_lng = grid.unproject(*grid.project(lat, lng))
    assert np.allclose(back_lat, lat, atol=1e-9) and np.allclose(back_lng, lng, atol=1e-9)


def test_projection_matches_known_distance():
    # London -> Edinburgh is ~534 km great-circle.
    x, y = grid.project([51.5074, 55.9533], [-0.1278, -3.1883])
    assert abs(np.hypot(x[1] - x[0], y[1] - y[0]) / 1000 - 534) < 6


def test_point_lands_in_its_own_cell():
    rng = np.random.default_rng(1)
    x, y = rng.uniform(-1e6, 1e6, 5000), rng.uniform(-1e6, 1e6, 5000)
    q, r = grid.to_cell(x, y, 400)
    cx, cy = grid.cell_center(q, r, 400)
    # Inside a pointy-top hex every point is within `size` of the centre.
    assert np.hypot(x - cx, y - cy).max() <= 400 + 1e-6


def test_gi_star_finds_planted_hotspot():
    rng = np.random.default_rng(2)
    q, r = np.meshgrid(np.arange(-20, 20), np.arange(-20, 20))
    q, r = q.ravel(), r.ravel()
    v = rng.poisson(2, len(q)).astype(float)
    planted = (np.abs(q) <= 1) & (np.abs(r) <= 1)
    v[planted] += 40
    aq, ar, _, z, observed = stats.gi_star(q, r, v)
    sig = stats.hot_significant(z, 0.01)
    found = {(a, b) for a, b, s in zip(aq, ar, sig) if s}
    assert (0, 0) in found
    assert all(abs(a) <= 3 and abs(b) <= 3 for a, b in found)


def test_components():
    q = np.array([0, 1, 0, 10, 11])
    r = np.array([0, 0, 1, 10, 10])
    labels = stats.components(q, r)
    assert labels[0] == labels[1] == labels[2] and labels[3] == labels[4] and labels[0] != labels[3]


def test_end_to_end(tmp_path):
    zpath = tmp_path / "fake.zip"
    zpath.write_bytes(make_zip().getvalue())
    df = load_archive(zpath, months=2)
    assert set(df["month"]) == {"2025-02", "2025-03"}
    out = tmp_path / "data"
    build(df, out)
    meta = json.loads((out / "meta.json").read_text())
    zones = json.loads((out / "zones.json").read_text())["zones"]
    assert [m["month"] for m in meta["months"]] == ["2025-02", "2025-03"]
    assert any(f["id"] == "greater-manchester" for f in meta["coverage"]["missing"])
    assert zones and abs(zones[0]["center"][0] - 51.51) < 0.1  # London ranks first
    tiles = json.loads((out / "detail" / "index.json").read_text())["tiles"]
    assert all((out / "detail" / f"{t}.json").exists() for t in tiles)


def test_split_zones_breaks_up_blobs():
    q, r = np.meshgrid(np.arange(0, 10), np.arange(0, 10))
    q, r = q.ravel(), r.ravel()
    score = np.ones(len(q))
    score[(q < 2) & (r < 2)] = 50      # core A
    score[(q > 7) & (r > 7)] = 50      # core B
    labels = stats.split_zones(q, r, score, max_cells=10)
    a = set(labels[(q < 2) & (r < 2)])
    b = set(labels[(q > 7) & (r > 7)])
    assert len(a) == 1 and len(b) == 1 and a != b and -1 not in a
