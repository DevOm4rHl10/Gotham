"""Single source of truth for paths, grid sizes and crime weights."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_DATA = ROOT / "site" / "data"
CACHE = ROOT / ".cache"

# data.police.uk publishes one zip per month; each holds the previous 36 months.
ARCHIVE_URL = "https://data.police.uk/data/archive/{name}.zip"

# Hex sizes in metres (centre to corner). Area = 2.598 * s^2.
DISTRICT_SIZE = 1600   # ~6.6 km2, national view
DETAIL_SIZE = 400      # ~0.42 km2, street view
CHUNK_METRES = 25_000  # detail cells are split into 25 km tiles, loaded on demand

# Benjamini-Hochberg false discovery rate for Gi* hotspots.
FDR = 0.01

# Hotspot zones bigger than this (cells of DETAIL_SIZE) are split into cores.
MAX_ZONE_CELLS = 30   # ~12.5 km2

# Relative harm weights. These are illustrative, ordered roughly by typical
# sentencing severity (in the spirit of the ONS Crime Severity Score), NOT
# official values. Anti-social behaviour is an incident, not a crime, so it
# is counted but carries no harm weight. Edit freely; everything downstream
# reads from here.
CATEGORIES = {
    # slug: (label, weight)
    "violent-crime": ("Violence and sexual offences", 10.0),
    "robbery": ("Robbery", 8.0),
    "possession-of-weapons": ("Possession of weapons", 6.0),
    "burglary": ("Burglary", 5.0),
    "drugs": ("Drugs", 3.0),
    "theft-from-the-person": ("Theft from the person", 3.0),
    "criminal-damage-arson": ("Criminal damage and arson", 3.0),
    "vehicle-crime": ("Vehicle crime", 2.0),
    "public-order": ("Public order", 2.0),
    "other-crime": ("Other crime", 2.0),
    "other-theft": ("Other theft", 1.0),
    "bicycle-theft": ("Bicycle theft", 1.0),
    "shoplifting": ("Shoplifting", 1.0),
    "anti-social-behaviour": ("Anti-social behaviour", 0.0),
}
LABEL_TO_SLUG = {label: slug for slug, (label, _) in CATEGORIES.items()}

# Every force that publishes to data.police.uk (from /api/forces).
# Used to report coverage gaps instead of silently showing "no crime".
KNOWN_FORCES = {
    "avon-and-somerset": "Avon and Somerset Constabulary",
    "bedfordshire": "Bedfordshire Police",
    "btp": "British Transport Police",
    "cambridgeshire": "Cambridgeshire Constabulary",
    "cheshire": "Cheshire Constabulary",
    "city-of-london": "City of London Police",
    "cleveland": "Cleveland Police",
    "cumbria": "Cumbria Constabulary",
    "derbyshire": "Derbyshire Constabulary",
    "devon-and-cornwall": "Devon & Cornwall Police",
    "dorset": "Dorset Police",
    "durham": "Durham Constabulary",
    "dyfed-powys": "Dyfed-Powys Police",
    "essex": "Essex Police",
    "gloucestershire": "Gloucestershire Constabulary",
    "greater-manchester": "Greater Manchester Police",
    "gwent": "Gwent Police",
    "hampshire": "Hampshire Constabulary",
    "hertfordshire": "Hertfordshire Constabulary",
    "humberside": "Humberside Police",
    "kent": "Kent Police",
    "lancashire": "Lancashire Constabulary",
    "leicestershire": "Leicestershire Police",
    "lincolnshire": "Lincolnshire Police",
    "merseyside": "Merseyside Police",
    "metropolitan": "Metropolitan Police Service",
    "norfolk": "Norfolk Constabulary",
    "north-wales": "North Wales Police",
    "north-yorkshire": "North Yorkshire Police",
    "northamptonshire": "Northamptonshire Police",
    "northern-ireland": "Police Service of Northern Ireland",
    "northumbria": "Northumbria Police",
    "nottinghamshire": "Nottinghamshire Police",
    "south-wales": "South Wales Police",
    "south-yorkshire": "South Yorkshire Police",
    "staffordshire": "Staffordshire Police",
    "suffolk": "Suffolk Constabulary",
    "surrey": "Surrey Police",
    "sussex": "Sussex Police",
    "thames-valley": "Thames Valley Police",
    "warwickshire": "Warwickshire Police",
    "west-mercia": "West Mercia Police",
    "west-midlands": "West Midlands Police",
    "west-yorkshire": "West Yorkshire Police",
    "wiltshire": "Wiltshire Police",
}

# Where to place an on-map note when a force has no data. lat, lng.
COVERAGE_ANCHORS = {
    "greater-manchester": (53.58, -2.30),  # north of the centre, clear of nearby triangles
}
