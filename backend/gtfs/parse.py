from pathlib import Path
import pandas as pd


def read_gtfs_table(gtfs_dir: str, filename: str) -> pd.DataFrame:
    path = Path(gtfs_dir) / filename
    if not path.exists():
        raise FileNotFoundError(f"Missing GTFS file: {path}")
    # GTFS is CSV with commas
    return pd.read_csv(path, low_memory=False)


def load_gtfs(gtfs_dir: str):
    stops = read_gtfs_table(gtfs_dir, "stops.txt")
    routes = read_gtfs_table(gtfs_dir, "routes.txt")
    trips = read_gtfs_table(gtfs_dir, "trips.txt")
    stop_times = read_gtfs_table(gtfs_dir, "stop_times.txt")
    shapes = read_gtfs_table(gtfs_dir, "shapes.txt")
    return stops, routes, trips, stop_times, shapes