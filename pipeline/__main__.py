"""
Usage:
  python -m pipeline                          # download latest bulk archive, last 12 months
  python -m pipeline --months 24
  python -m pipeline --archive path/to/2025-11.zip
  python -m pipeline --json-dir data/         # use your old crimes_YYYY-MM.json files
"""
import argparse
from pathlib import Path

from .build import build
from .config import SITE_DATA
from .ingest import download_archive, load_archive, load_json_dir


def main():
    p = argparse.ArgumentParser(prog="pipeline", description="Build Gotham's static map data.")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--archive", type=Path, help="local data.police.uk bulk zip")
    src.add_argument("--json-dir", type=Path, help="folder of crimes_YYYY-MM.json files")
    p.add_argument("--release", default="latest", help="archive name to download, e.g. 2025-11")
    p.add_argument("--months", type=int, default=12)
    p.add_argument("--out", type=Path, default=SITE_DATA)
    args = p.parse_args()

    if args.json_dir:
        df = load_json_dir(args.json_dir)
    else:
        df = load_archive(args.archive or download_archive(args.release), args.months)
    build(df, args.out)


if __name__ == "__main__":
    main()
