from __future__ import annotations
import math
from typing import Dict, List, Tuple
import pandas as pd

# Aston centre (same as your frontend). Adjust if needed.
ASTON_CENTER = (52.492, -1.890)  # (lat, lng)

def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    s = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2)
    return 2 * R * math.asin(math.sqrt(s))

def build_aston_network(
    stops: pd.DataFrame,
    routes: pd.DataFrame,
    trips: pd.DataFrame,
    stop_times: pd.DataFrame,
    shapes: pd.DataFrame,
    buffer_meters: int = 1500,
    bbox: Tuple[float, float, float, float] | None = None,  # (minLat,minLng,maxLat,maxLng)
) -> Dict:
    buffer_km = buffer_meters / 1000.0


    
    # 1) Filter stops within buffer of Aston centre (Tier 1 quick filter)
    # Later: replace with your real polygon + point-in-polygon (we can do that next)
    stops = stops.copy()
    stops["lat"] = stops["stop_lat"].astype(float)
    stops["lng"] = stops["stop_lon"].astype(float)
    stops["dist_km"] = stops.apply(
        lambda r: haversine_km((r["lat"], r["lng"]), ASTON_CENTER), axis=1
    )

    stops_near = stops.copy()
    stop_id_set = set(stops_near["stop_id"].astype(str).tolist())


    if bbox is not None:
        minLat, minLng, maxLat, maxLng = bbox
        stops_near = stops[
            (stops["lat"] >= minLat) & (stops["lat"] <= maxLat) &
            (stops["lng"] >= minLng) & (stops["lng"] <= maxLng)
        ].copy()
    else:
        buffer_km = buffer_meters / 1000.0
        stops["dist_km"] = stops.apply(
            lambda r: haversine_km((r["lat"], r["lng"]), ASTON_CENTER), axis=1
        )
        stops_near = stops[stops["dist_km"] <= buffer_km].copy()

    # 2) Find trips that serve these stops
    st = stop_times.copy()
    st["stop_id"] = st["stop_id"].astype(str)
    st_near = st[st["stop_id"].isin(stop_id_set)]
    trip_ids = set(st_near["trip_id"].astype(str).tolist())

    trips2 = trips.copy()
    trips2["trip_id"] = trips2["trip_id"].astype(str)
    trips2 = trips2[trips2["trip_id"].isin(trip_ids)]

    # 3) For each route, pick ONE representative trip (most common pattern)
    # and extract its ordered stop sequence
    trips2["route_id"] = trips2["route_id"].astype(str)
    route_to_trip = (
        trips2.groupby("route_id")["trip_id"]
        .agg(lambda s: s.iloc[0])
        .to_dict()
    )

    # 4) Shapes: build shape_id -> ordered points
    shapes2 = shapes.copy()
    shapes2["shape_id"] = shapes2["shape_id"].astype(str)
    shapes2["shape_pt_sequence"] = shapes2["shape_pt_sequence"].astype(int)
    shapes2 = shapes2.sort_values(["shape_id", "shape_pt_sequence"])

    shape_points = {}
    for sid, g in shapes2.groupby("shape_id"):
        pts = list(zip(g["shape_pt_lat"].astype(float), g["shape_pt_lon"].astype(float)))
        shape_points[sid] = pts

    # 5) Build route objects
    routes2 = routes.copy()
    routes2["route_id"] = routes2["route_id"].astype(str)

    out_routes: List[Dict] = []
    for _, r in routes2.iterrows():
        rid = str(r["route_id"])
        if rid not in route_to_trip:
            continue

        trip_id = route_to_trip[rid]

        # ordered stops for that trip
        st_trip = stop_times[stop_times["trip_id"].astype(str) == trip_id].copy()
        st_trip["stop_sequence"] = st_trip["stop_sequence"].astype(int)
        st_trip = st_trip.sort_values("stop_sequence")
        stop_ids = [str(x) for x in st_trip["stop_id"].tolist()]

        # keep only routes that actually have some stops near Aston
        if not any(sid in stop_id_set for sid in stop_ids):
            continue

        # representative shape
        shape_id = None
        trow = trips2[trips2["trip_id"] == trip_id]
        if "shape_id" in trow.columns and len(trow) > 0 and not pd.isna(trow.iloc[0].get("shape_id", None)):
            shape_id = str(trow.iloc[0]["shape_id"])

        shape = shape_points.get(shape_id, [])

        out_routes.append({
            "id": rid,
            "shortName": str(r.get("route_short_name", "")),
            "longName": str(r.get("route_long_name", "")),
            "color": str(r.get("route_color", "")) or "2E7D32",
            "stopIds": stop_ids,
            "shape": shape,
            "headwayMins": None,  # we can derive later from stop_times if needed
        })

    out_stops = [{
        "id": str(row["stop_id"]),
        "name": str(row.get("stop_name", "")),
        "lat": float(row["lat"]),
        "lng": float(row["lng"]),
    } for _, row in stops_near.iterrows()]

    return {
        "stops": out_stops,
        "routes": out_routes,
        "meta": {
            "source": "tfwm-gtfs",
            "bufferMeters": buffer_meters,
            "stopsReturned": len(out_stops),
            "routesReturned": len(out_routes),
        }
    }
