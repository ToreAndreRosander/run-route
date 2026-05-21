"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import mapboxgl, { GeoJSONSource, LngLatLike, Map, Marker } from "mapbox-gl";
import styles from "./page.module.css";

type Coordinates = [number, number];

type RouteResponse = {
  id: string;
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationSeconds: number;
  endDistanceMeters: number;
  targetDistanceMeters: number;
};

type RoutesResponse = {
  routes: RouteResponse[];
};

const DEFAULT_CENTER: Coordinates = [10.7522, 59.9139];

export default function RoutePlanner() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const marker = useRef<Marker | null>(null);
  const [start, setStart] = useState<Coordinates | null>(null);
  const [distanceKm, setDistanceKm] = useState(5);
  const [routes, setRoutes] = useState<RouteResponse[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
  const selectedRoute = routes[selectedRouteIndex] ?? null;

  useEffect(() => {
    if (!mapContainer.current || map.current || !accessToken) {
      return;
    }

    mapboxgl.accessToken = accessToken;
    const nextMap = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/rosander/cmpfrmomg001201sgeczua5od",
      center: DEFAULT_CENTER as LngLatLike,
      zoom: 12,
    });

    nextMap.addControl(new mapboxgl.NavigationControl(), "top-right");
    nextMap.on("click", (event) => {
      setStart([event.lngLat.lng, event.lngLat.lat]);
      setRoutes([]);
      setSelectedRouteIndex(0);
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
    if (!currentMap) {
      return;
    }

    if (!selectedRoute) {
      if (currentMap.getLayer("running-route-line")) {
        currentMap.removeLayer("running-route-line");
      }

      if (currentMap.getSource("running-route")) {
        currentMap.removeSource("running-route");
      }

      return;
    }

    let isCancelled = false;

    const updateRouteLayer = () => {
      if (isCancelled) {
        return;
      }

      const data: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: selectedRoute.geometry,
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

      const bounds = selectedRoute.geometry.coordinates.reduce(
        (nextBounds, coordinate) => nextBounds.extend(coordinate as Coordinates),
        new mapboxgl.LngLatBounds(
          selectedRoute.geometry.coordinates[0] as Coordinates,
          selectedRoute.geometry.coordinates[0] as Coordinates,
        ),
      );
      currentMap.fitBounds(bounds, { padding: 70, maxZoom: 15 });
    };

    if (currentMap.loaded()) {
      updateRouteLayer();
    } else {
      currentMap.once("load", updateRouteLayer);
    }

    return () => {
      isCancelled = true;
    };
  }, [selectedRoute]);

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
      const data = (await response.json()) as RoutesResponse | { error: string };

      if (!response.ok) {
        throw new Error("error" in data ? data.error : "Could not find a route.");
      }

      const routeOptions = (data as RoutesResponse).routes;
      if (!Array.isArray(routeOptions) || routeOptions.length === 0) {
        throw new Error("Could not find a route.");
      }

      setRoutes(routeOptions);
      setSelectedRouteIndex(0);
    } catch (nextError) {
      setRoutes([]);
      setSelectedRouteIndex(0);
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
        setRoutes([]);
        setSelectedRouteIndex(0);
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
              onChange={(event) => {
                setDistanceKm(Number(event.target.value));
                setRoutes([]);
                setSelectedRouteIndex(0);
              }}
            />
          </label>

          <button className={styles.primaryButton} disabled={isLoading} type="submit">
            {isLoading ? "Finding route..." : "Find route"}
          </button>

          {error && <p className={styles.error}>{error}</p>}

          {routes.length > 0 && (
            <div className={styles.routeOptions}>
              <h3>Choose a route</h3>
              <div className={styles.optionList}>
                {routes.map((routeOption, index) => (
                  <button
                    className={
                      index === selectedRouteIndex
                        ? styles.routeOptionActive
                        : styles.routeOption
                    }
                    key={routeOption.id}
                    type="button"
                    onClick={() => setSelectedRouteIndex(index)}
                  >
                    <span>Option {index + 1}</span>
                    <strong>{(routeOption.distanceMeters / 1000).toFixed(2)} km</strong>
                    <small>{Math.round(routeOption.durationSeconds / 60)} min</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedRoute && (
            <div className={styles.result}>
              <h3>Selected route</h3>
              <dl>
                <div>
                  <dt>Distance</dt>
                  <dd>{(selectedRoute.distanceMeters / 1000).toFixed(2)} km</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{(selectedRoute.targetDistanceMeters / 1000).toFixed(2)} km</dd>
                </div>
                <div>
                  <dt>Estimated time</dt>
                  <dd>{Math.round(selectedRoute.durationSeconds / 60)} min</dd>
                </div>
                <div>
                  <dt>Finish from start</dt>
                  <dd>{Math.round(selectedRoute.endDistanceMeters)} m</dd>
                </div>
              </dl>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
