import json
import requests
from pathlib import Path



# Reading the 
try:
    with open('data/forces.json', 'r') as file:
        data = json.load(file)
    #print("File data =", data)
    
except FileNotFoundError:
    print("Error: The file 'data/forces.json' was not found.")
    
    
    
all_neighbourhoods = []
#Save Ids and names, and get neighbourhoods  
ids = set()
names = set()
for elem in data:
    force_id = elem['id']
    force_name = elem['name']
    print("ID:", elem['id'], "Name:", elem['name'])
    ids.add(elem['id'])
    names.add(elem['name'])
    url = f"https://data.police.uk/api/{force_id}/neighbourhoods"
    print(f"Fetching neighbourhoods for {force_id}... The url is: {url}")
    r = requests.get(url, timeout=30)
    r.raise_for_status()

    neighbourhoods = r.json()

    for n in neighbourhoods:
        all_neighbourhoods.append({
            "force_id": force_id,
            "neighbourhood_id": n["id"],
            "name": n["name"]
        })
        
        
# Save the collected neighbourhoods to a JSON file (optional)
print(f"Collected {len(all_neighbourhoods)} neighbourhoods")

# Create data/ folder if it doesn't exist
data_dir = Path("data")
data_dir.mkdir(exist_ok=True)


output_file = data_dir / "all_neighbourhoods.json"

with output_file.open("w", encoding="utf-8") as f:
    json.dump(all_neighbourhoods, f, indent=2)

print(f"Saved to {output_file}")
    