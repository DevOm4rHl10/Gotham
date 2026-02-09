import requests
import json
from pathlib import Path

URL = "https://data.police.uk/api/forces"

# Create data/ folder if it doesn't exist
data_dir = Path("data")
data_dir.mkdir(exist_ok=True)

print("Fetching force data...")
response = requests.get(URL, timeout=30)
response.raise_for_status()

forces = response.json()
print(f"Fetched {len(forces)} forces")

output_file = data_dir / "forces.json"

with output_file.open("w", encoding="utf-8") as f:
    json.dump(forces, f, indent=2)

print(f"Saved to {output_file}")
