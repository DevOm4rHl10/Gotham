"""Build a fake data.police.uk bulk zip for tests. Not real crime data."""
import io
import zipfile

import numpy as np

from pipeline.config import CATEGORIES

TOWNS = [  # (force, lat, lng, intensity)
    ("metropolitan", 51.512, -0.128, 9000),
    ("west-midlands", 52.480, -1.900, 4000),
    ("west-yorkshire", 53.797, -1.548, 3000),
    ("merseyside", 53.408, -2.985, 3000),
    ("avon-and-somerset", 51.455, -2.592, 2000),
    ("northumbria", 54.973, -1.614, 2000),
    ("south-wales", 51.481, -3.179, 1800),
    ("northern-ireland", 54.597, -5.930, 1800),
    ("south-yorkshire", 53.381, -1.470, 1800),
    ("nottinghamshire", 52.954, -1.158, 1500),
    ("leicestershire", 52.636, -1.133, 1200),
    ("hampshire", 50.904, -1.404, 1200),
    ("sussex", 50.822, -0.137, 1200),
    ("norfolk", 52.630, 1.297, 800),
    ("devon-and-cornwall", 50.375, -4.143, 900),
    ("cleveland", 54.574, -1.235, 1100),
    ("humberside", 53.744, -0.333, 1000),
    ("thames-valley", 51.752, -1.258, 900),
    ("cambridgeshire", 52.205, 0.122, 700),
    ("north-yorkshire", 53.959, -1.082, 600),
    ("kent", 51.280, 1.080, 700),
    ("lancashire", 53.763, -2.703, 1000),
    ("staffordshire", 53.003, -2.179, 900),
    ("btp", 51.531, -0.124, 400),
]
LABELS = [label for label, _ in CATEGORIES.values()]
CAT_P = np.array([.30, .03, .01, .06, .05, .03, .09, .06, .07, .02, .09, .02, .08, .09])
STREETS = ["High Street", "Station Road", "Market Place", "Church Lane", "Queen Street", "Mill Road"]


def make_zip(months=("2025-01", "2025-02", "2025-03"), scale=0.05, seed=0):
    rng = np.random.default_rng(seed)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for m in months:
            for force, lat, lng, n in TOWNS:
                n = int(n * scale * rng.uniform(0.85, 1.15))
                # Dense core + diffuse suburbs, snapped to ~300 m "map points".
                core = rng.normal([lat, lng], [0.006, 0.009], size=(n // 3, 2))
                wide = rng.normal([lat, lng], [0.06, 0.09], size=(n - n // 3, 2))
                pts = np.round(np.vstack([core, wide]) / 0.003) * 0.003
                cats = rng.choice(LABELS, size=len(pts), p=CAT_P / CAT_P.sum())
                lines = ["Crime ID,Month,Reported by,Falls within,Longitude,Latitude,Location,"
                         "LSOA code,LSOA name,Crime type,Last outcome category,Context"]
                for (a, b), c in zip(pts, cats):
                    street = STREETS[int(abs(a * 1000 + b * 1000)) % len(STREETS)]
                    lines.append(f",{m},{force},{force},{b:.6f},{a:.6f},On or near {street},"
                                 f"E01000001,Town{abs(hash(force)) % 97} 001A,{c},,")
                zf.writestr(f"{m}/{m}-{force}-street.csv", "\n".join(lines))
    buf.seek(0)
    return buf
