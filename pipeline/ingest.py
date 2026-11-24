"""Load crime records into one tidy DataFrame.

Columns: month, force, lat, lng, category, place
  place = "<street>, <area>" when known, used to name hotspots.

Two sources:
  archive  the official monthly bulk download (recommended, complete)
  json     the crimes_YYYY-MM.json files from the old API scraper
"""
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

from .config import ARCHIVE_URL, CACHE, LABEL_TO_SLUG

STREET_FILE = re.compile(r"(?:^|/)(\d{4}-\d{2})/\1-(.+)-street\.csv$")
USECOLS = ["Longitude", "Latitude", "Location", "LSOA name", "Crime type"]


def download_archive(name="latest"):
    """Download (once) the bulk zip. Returns its path."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"police-{name}.zip"
    if path.exists() and path.stat().st_size > 0:
        print(f"Using cached {path}")
        return path
    url = ARCHIVE_URL.format(name=name)
    print(f"Downloading {url} (large; one-off)...")
    tmp = path.with_suffix(".part")
    req = urllib.request.Request(url, headers={"User-Agent": "gotham-pipeline"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        shutil.copyfileobj(resp, out, length=1 << 20)
    tmp.rename(path)
    return path


def _clean_place(location, area):
    street = re.sub(r"^On or near\s+", "", str(location or "")).strip()
    if street.lower() in {"", "nan", "no location"}:
        street = ""
    # LSOA names look like "Westminster 018A"; keep the district part.
    area = re.sub(r"\s+\d{3}[A-Z]$", "", str(area or "")).strip()
    if area.lower() == "nan":
        area = ""
    return ", ".join(p for p in (street, area) if p)


def load_archive(path, months=12):
    """Read the last `months` months of street-level CSVs from a bulk zip."""
    frames = []
    with zipfile.ZipFile(path) as zf:
        members = [(m.group(1), m.group(2), name)
                   for name in zf.namelist() if (m := STREET_FILE.search(name))]
        if not members:
            sys.exit(f"No *-street.csv files found in {path}")
        available = sorted({month for month, _, _ in members})
        wanted = set(available[-months:])
        print(f"Archive covers {available[0]}..{available[-1]}; using {min(wanted)}..{max(wanted)}")
        for month, force, name in sorted(members):
            if month not in wanted:
                continue
            with zf.open(name) as fh:
                df = pd.read_csv(fh, usecols=USECOLS, dtype=str)
            df["month"] = month
            df["force"] = force
            frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["lat"] = pd.to_numeric(df["Latitude"], errors="coerce")
    df["lng"] = pd.to_numeric(df["Longitude"], errors="coerce")
    df["category"] = df["Crime type"].map(LABEL_TO_SLUG).fillna("other-crime")
    places = {(a, b): _clean_place(a, b) for a, b in
              df[["Location", "LSOA name"]].drop_duplicates().itertuples(index=False)}
    df["place"] = [places[(a, b)] for a, b in zip(df["Location"], df["LSOA name"])]
    return _finish(df)


def load_json_dir(directory, neighbourhoods=None):
    """Read crimes_YYYY-MM.json files written by the old API scraper."""
    directory = Path(directory)
    files = sorted(directory.glob("crimes_*.json"))
    if not files:
        sys.exit(f"No crimes_*.json files in {directory}")
    force_of = {}
    nb = Path(neighbourhoods) if neighbourhoods else directory / "all_neighbourhoods.json"
    if nb.exists():
        force_of = {n["neighbourhood_id"]: n["force_id"] for n in json.loads(nb.read_text())}
    rows = []
    for f in files:
        for c in json.loads(f.read_text())["crimes"]:
            rows.append((c.get("month"), force_of.get(c.get("neighbourhood_id"), "unknown"),
                         c.get("lat"), c.get("lng"), c.get("category"),
                         _clean_place(c.get("street_name"), c.get("neighbourhood_name"))))
    df = pd.DataFrame(rows, columns=["month", "force", "lat", "lng", "category", "place"])
    df["category"] = df["category"].where(df["category"].isin(LABEL_TO_SLUG.values()), "other-crime")
    return _finish(df)


def _finish(df):
    df = df.dropna(subset=["lat", "lng", "month"])
    # The archive zeroes coordinates it cannot place; drop anything outside the UK box.
    df = df[df["lat"].between(49.0, 61.5) & df["lng"].between(-9.0, 2.5)]
    return df[["month", "force", "lat", "lng", "category", "place"]].reset_index(drop=True)
