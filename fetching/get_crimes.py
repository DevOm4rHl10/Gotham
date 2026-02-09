# THIS SCRIPT FETCHES CRIMES AROUND NEIGHBOURHOOD CENTROIDS
# IT IS SAFE TO STOP AND RESUME, AND SAVES DATA MONTHLY

import json
import time
from pathlib import Path
from datetime import datetime
import requests

# ------------------------
# CONFIG
# ------------------------

CENTROIDS_FILE = "data/neighbourhoods_with_centroids.json"
BASE_URL = "https://data.police.uk/api/crimes-street/all-crime"

# List months to fetch
DATES = [
    "2025-01",
    "2025-02",
    "2025-03",
    "2025-04",
    "2025-05",
    "2025-06",
    "2025-07",
    "2025-08",
    "2025-09",
    "2025-10",
    "2025-11",
]

REQUEST_TIMEOUT = 30
RETRIES = 5
BACKOFF_BASE = 2
DELAY_BETWEEN_REQUESTS = 0.5
SAVE_EVERY = 50  # Save after this many requests

# ------------------------
# HELPERS
# ------------------------

def fetch_with_retry(url, params, retries=RETRIES, backoff=BACKOFF_BASE):
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Request failed (attempt {attempt}/{retries}): {e}")
            if attempt == retries:
                return None
            time.sleep(backoff ** attempt)

def save_month(unique_crimes, date):
    """Save the unique crimes for a specific month."""
    output_file = f"data/crimes_{date}.json"
    output = {
        "meta": {
            "source": "data.police.uk",
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "month": date,
            "total_unique_crimes": len(unique_crimes),
        },
        "crimes": list(unique_crimes.values()),
    }
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"[{date}] Saved {len(unique_crimes)} unique crimes to {output_file}")

# ------------------------
# LOAD INPUT DATA
# ------------------------

with open(CENTROIDS_FILE, "r", encoding="utf-8") as f:
    neighbourhoods = json.load(f)

centroids = [
    {
        "neighbourhood_id": nh["neighbourhood_id"],
        "name": nh["name"],
        "lat": nh["centroid"]["lat"],
        "lng": nh["centroid"]["lng"],
    }
    for nh in neighbourhoods
    if nh.get("centroid")
]

print(f"Loaded {len(centroids)} centroids")

# ------------------------
# MAIN LOOP
# ------------------------

total_tasks = len(DATES) * len(centroids)
task_index = 0

for date in DATES:

    # Load existing data for this month if present
    month_file = Path(f"data/crimes_{date}.json")
    if month_file.exists():
        with open(month_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
            unique_crimes = {c["id"]: c for c in existing.get("crimes", [])}
        print(f"[{date}] Resuming with {len(unique_crimes)} existing crimes")
    else:
        unique_crimes = {}
        print(f"[{date}] Starting fresh")

    for center in centroids:
        task_index += 1
        print(f"[{task_index}/{total_tasks}] {center['name']} – {date}")

        params = {
            "date": date,
            "lat": center["lat"],
            "lng": center["lng"],
        }

        crimes = fetch_with_retry(BASE_URL, params)
        if crimes is None:
            print("Skipping due to repeated failures")
            continue

        print(f"Fetched {len(crimes)} crimes")

        for c in crimes:
            crime_id = c.get("id")
            if crime_id is None or crime_id in unique_crimes:
                continue

            location = c.get("location") or {}
            street = location.get("street") or {}
            outcome = c.get("outcome_status") or {}

            unique_crimes[crime_id] = {
                "id": crime_id,
                "category": c.get("category"),
                "month": c.get("month"),

                "lat": float(location["latitude"]) if location.get("latitude") else None,
                "lng": float(location["longitude"]) if location.get("longitude") else None,
                "street_name": street.get("name"),

                "outcome_category": outcome.get("category"),
                "outcome_date": outcome.get("date"),

                "neighbourhood_id": center["neighbourhood_id"],
                "neighbourhood_name": center["name"],

                "query_lat": center["lat"],
                "query_lng": center["lng"],
            }

        if task_index % SAVE_EVERY == 0:
            save_month(unique_crimes, date)

        time.sleep(DELAY_BETWEEN_REQUESTS)

    # Final save for this month
    save_month(unique_crimes, date)

print("All months processed. Done!")
