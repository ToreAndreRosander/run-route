"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import mapboxgl, { GeoJSONSource, LngLatLike, Map, Marker } from "mapbox-gl";
import styles from "./page.module.css";

type Coordinates = [number, number];

type RouteResponse = {
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationSeconds: number;
  endDistanceMeters: number;
  targetDistanceMeters: number;
};

const DEFAULT_CENTER: Coordinates = [10.7522, 59.9139];

export default function RoutePlanner() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const marker = useRef<Marker | null>(null);
  const [start, setStart] = useState<Coordinates | null>(null);
  const [distanceKm, setDistanceKm] = useState(5);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  useEffect(() => {
    if (!mapContainer.current || map.current || !accessToken) {
      return;
    }

    mapboxgl.accessToken = accessToken;
    const nextMap = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/outdoors-v12",
      center: DEFAULT_CENTER as LngLatLike,
      zoom: 12,
    });

    nextMap.addControl(new mapboxgl.NavigationControl(), "top-right");
    nextMap.on("click", (event) => {
      setStart([event.lngLat.lng, event.lngLat.lat]);
      setRoute(null);
      setError(null);
    });

    map.current = nextMap;

    return () => {
      marker.current?.remove();
      nextMap.remove();
      map.current = null;
      marker.current = null;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!map.current || !start) {
      return;
    }

    if (!marker.current) {
      marker.current = new mapboxgl.Marker({ color: "#ef4444" })
        .setLngLat(start)
        .addTo(map.current);
    } else {
      marker.current.setLngLat(start);
    }

    map.current.flyTo({ center: start, zoom: Math.max(map.current.getZoom(), 13) });
  }, [start]);

  useEffect(() => {
    const currentMap = map.current;
    if (!currentMap || !route) {
      return;
    }

    const updateRouteLayer = () => {
      const data: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: route.geometry,
      };

      if (currentMap.getSource("running-route")) {
        (currentMap.getSource("running-route") as GeoJSONSource).setData(data);
      } else {
        currentMap.addSource("running-route", {
          type: "geojson",
          data,
        });
        currentMap.addLayer({
          id: "running-route-line",
          type: "line",
          source: "running-route",
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
          paint: {
            "line-color": "#2563eb",
            "line-width": 5,
          },
        });
      }

      const bounds = route.geometry.coordinates.reduce(
        (nextBounds, coordinate) => nextBounds.extend(coordinate as Coordinates),
        new mapboxgl.LngLatBounds(
          route.geometry.coordinates[0] as Coordinates,
          route.geometry.coordinates[0] as Coordinates,
        ),
      );
      currentMap.fitBounds(bounds, { padding: 70, maxZoom: 15 });
    };

    if (currentMap.loaded()) {
      updateRouteLayer();
    } else {
      currentMap.once("load", updateRouteLayer);
    }
  }, [route]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!start) {
      setError("Select a starting point on the map first.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, distanceKm }),
      });
      const data = (await response.json()) as RouteResponse | { error: string };

      if (!response.ok) {
        throw new Error("error" in data ? data.error : "Could not find a route.");
      }

      setRoute(data as RouteResponse);
    } catch (nextError) {
      setRoute(null);
      setError(
        nextError instanceof Error ? nextError.message : "Could not find a route.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError("Your browser does not support geolocation.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStart([position.coords.longitude, position.coords.latitude]);
        setError(null);
      },
      () => setError("Could not read your current location."),
      { enableHighAccuracy: true },
    );
  };

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Mapbox powered route finder</p>
          <h1>Find a running route from anywhere.</h1>
          <p className={styles.lead}>
            Pick a starting point, choose roughly how far you want to run, and
            Run Route will look for a loop that finishes close to where you
            began.
          </p>
        </div>
      </section>

      <section className={styles.planner}>
        <div className={styles.mapPanel}>
          <div ref={mapContainer} className={styles.map} aria-label="Map">
            {!accessToken && (
              <div className={styles.mapFallback}>
                Add <code>NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code> to enable the
                interactive Mapbox map.
              </div>
            )}
          </div>
        </div>

        <form className={styles.controls} onSubmit={handleSubmit}>
          <h2>Plan your run</h2>
          <p>Click the map or use your browser location to set the start.</p>

          <button
            className={styles.secondaryButton}
            type="button"
            onClick={useCurrentLocation}
          >
            Use my current location
          </button>

          <label className={styles.field}>
            Starting point
            <span className={styles.coordinates}>
              {start
                ? `${start[1].toFixed(5)}, ${start[0].toFixed(5)}`
                : "No point selected"}
            </span>
          </label>

          <label className={styles.field}>
            Approximate distance: {distanceKm} km
            <input
              type="range"
              min="2"
              max="30"
              step="1"
              value={distanceKm}
              onChange={(event) => setDistanceKm(Number(event.target.value))}
            />
          </label>

          <button className={styles.primaryButton} disabled={isLoading} type="submit">
            {isLoading ? "Finding route..." : "Find route"}
          </button>

          {error && <p className={styles.error}>{error}</p>}

          {route && (
            <div className={styles.result}>
              <h3>Suggested route</h3>
              <dl>
                <div>
                  <dt>Distance</dt>
                  <dd>{(route.distanceMeters / 1000).toFixed(2)} km</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{(route.targetDistanceMeters / 1000).toFixed(2)} km</dd>
                </div>
                <div>
                  <dt>Estimated time</dt>
                  <dd>{Math.round(route.durationSeconds / 60)} min</dd>
                </div>
                <div>
                  <dt>Finish from start</dt>
                  <dd>{Math.round(route.endDistanceMeters)} m</dd>
                </div>
              </dl>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
