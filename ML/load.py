# import required modules
import pandas as pd
import numpy as np
import json


#Should also load for the other months, but for now just load for November 2025
with open('data/crimes_2025-11.json', 'r') as file:
    data = json.load(file)

coords = [
    (crime["lat"], crime["lng"])
    for crime in data["crimes"]
    if crime.get("lat") is not None and crime.get("lng") is not None
]

X = np.array(coords)
