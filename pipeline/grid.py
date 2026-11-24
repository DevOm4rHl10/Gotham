"""Equal-area hexagonal grid.

Points are projected with a spherical Lambert azimuthal equal-area projection
using the EPSG:3035 (ETRS89-LAEA, Eurostat's grid) centre, then binned into
pointy-top hexagons. Equal area means a hex in Cornwall and a hex in Shetland
cover the same ground, so counts are comparable. It is also the projection
Eurostat grids use, so the same grid extends to the rest of Europe.

site/app.js mirrors these formulas exactly; keep them in sync.
"""
import numpy as np

R = 6371007.2                 # authalic radius, metres
LAT0 = np.radians(52.0)
LON0 = np.radians(10.0)
SQRT3 = np.sqrt(3.0)


def project(lat, lng):
    """WGS84 degrees -> LAEA metres (x east, y north). Vectorised."""
    phi = np.radians(np.asarray(lat, dtype=np.float64))
    lam = np.radians(np.asarray(lng, dtype=np.float64)) - LON0
    cos_c = np.sin(LAT0) * np.sin(phi) + np.cos(LAT0) * np.cos(phi) * np.cos(lam)
    k = np.sqrt(2.0 / (1.0 + cos_c))
    x = R * k * np.cos(phi) * np.sin(lam)
    y = R * k * (np.cos(LAT0) * np.sin(phi) - np.sin(LAT0) * np.cos(phi) * np.cos(lam))
    return x, y


def unproject(x, y):
    """LAEA metres -> WGS84 degrees (lat, lng). Vectorised."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    c = 2.0 * np.arcsin(np.clip(rho / (2.0 * R), -1, 1))
    safe = np.where(rho == 0, 1.0, rho)
    phi = np.arcsin(np.cos(c) * np.sin(LAT0) + y * np.sin(c) * np.cos(LAT0) / safe)
    lam = LON0 + np.arctan2(x * np.sin(c),
                            safe * np.cos(LAT0) * np.cos(c) - y * np.sin(LAT0) * np.sin(c))
    phi = np.where(rho == 0, LAT0, phi)
    lam = np.where(rho == 0, LON0, lam)
    return np.degrees(phi), np.degrees(lam)


def to_cell(x, y, size):
    """LAEA metres -> axial (q, r) of the pointy-top hex of `size` containing it."""
    qf = (SQRT3 / 3.0 * x - y / 3.0) / size
    rf = (2.0 / 3.0 * y) / size
    sf = -qf - rf
    q, r, s = np.rint(qf), np.rint(rf), np.rint(sf)
    dq, dr, ds = np.abs(q - qf), np.abs(r - rf), np.abs(s - sf)
    fix_q = (dq > dr) & (dq > ds)
    fix_r = ~fix_q & (dr > ds)
    q = np.where(fix_q, -r - s, q)
    r = np.where(fix_r, -q - s, r)
    return q.astype(np.int64), r.astype(np.int64)


def cell_center(q, r, size):
    q = np.asarray(q, dtype=np.float64)
    r = np.asarray(r, dtype=np.float64)
    return size * (SQRT3 * q + SQRT3 / 2.0 * r), size * 1.5 * r


def cell_area_km2(size):
    return 1.5 * SQRT3 * size * size / 1e6


# Neighbour offsets; index i is the neighbour across edge i (edge between
# corners i and i+1, corners at angle 60*i - 30 degrees).
NEIGHBOURS = np.array([(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)], dtype=np.int64)

_OFFSET = 1 << 24   # axial indices stay far inside +/-16M for any European grid
_SHIFT = 26


def key(q, r):
    """Pack axial coords into one int64 for fast lookups."""
    return ((np.asarray(q, dtype=np.int64) + _OFFSET) << _SHIFT) + (np.asarray(r, dtype=np.int64) + _OFFSET)


def unkey(k):
    k = np.asarray(k, dtype=np.int64)
    return (k >> _SHIFT) - _OFFSET, (k & ((1 << _SHIFT) - 1)) - _OFFSET
