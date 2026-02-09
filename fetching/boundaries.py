import json
import requests
from pathlib import Path
import numpy as np
import time
import random

data_file = Path("data/all_neighbourhoods.json")
output_file = Path("data/neighbourhoods_with_centroids.json")

with data_file.open("r", encoding="utf-8") as f:
    neighbourhoods = json.load(f)

def fetch_boundary(url, retries=5, delay=2):
    for i in range(retries):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as e:
            print(f"Request failed ({i+1}/{retries}): {e}")
            time.sleep(delay)
    print(f"Failed to fetch after {retries} retries: {url}")
    return []

for i, nh in enumerate(neighbourhoods):
    if "centroid" in nh and nh["centroid"] is not None:
        continue  # skip if already done

    url = f"https://data.police.uk/api/{nh['force_id']}/{nh['neighbourhood_id']}/boundary"
    print(f"Fetching boundary for {nh['neighbourhood_id']} ({i+1}/{len(neighbourhoods)})")

    boundaries = fetch_boundary(url)
    time.sleep(0.2 + random.random() * 0.3)  # polite delay

    if boundaries:
        coords = np.array([[float(p["latitude"]), float(p["longitude"])] for p in boundaries])
        lat_c, lng_c = coords.mean(axis=0)
        nh["centroid"] = {"lat": float(lat_c), "lng": float(lng_c)}
    else:
        nh["centroid"] = None

    # Optional: save progress every 10 neighbourhoods
    if i % 10 == 0:
        with output_file.open("w", encoding="utf-8") as f:
            json.dump(neighbourhoods, f, indent=2)

# Save final file
with output_file.open("w", encoding="utf-8") as f:
    json.dump(neighbourhoods, f, indent=2)

print(f"Saved {len(neighbourhoods)} neighbourhoods with centroids to {output_file}")
