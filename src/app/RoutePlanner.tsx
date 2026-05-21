"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
const PREVIEW_CAMERA_ALTITUDE_METERS = 220;
const PREVIEW_DURATION_MS = 12000;
const PREVIEW_LOOK_AHEAD_METERS = 90;
const DEFAULT_CAMERA_UP_VECTOR = undefined;

type RoutePreviewSegment = {
  start: Coordinates;
  end: Coordinates;
  distanceMeters: number;
  startsAtMeters: number;
};

type RoutePreviewTrack = {
  segments: RoutePreviewSegment[];
  totalDistanceMeters: number;
};

function getDistanceMeters(start: Coordinates, end: Coordinates) {
  // Haversine great-circle distance between two longitude/latitude pairs.
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const startLatitude = toRadians(start[1]);
  const endLatitude = toRadians(end[1]);
  const latitudeDelta = toRadians(end[1] - start[1]);
  const longitudeDelta = toRadians(end[0] - start[0]);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}

function createRoutePreviewTrack(coordinates: GeoJSON.Position[]) {
  const routeCoordinates = coordinates.map(
    (coordinate) => [coordinate[0], coordinate[1]] as Coordinates,
  );
  const segments: RoutePreviewSegment[] = [];
  let totalDistanceMeters = 0;

  for (let index = 1; index < routeCoordinates.length; index += 1) {
    const start = routeCoordinates[index - 1];
    const end = routeCoordinates[index];
    const distanceMeters = getDistanceMeters(start, end);

    if (distanceMeters === 0) {
      continue;
    }

    segments.push({
      start,
      end,
      distanceMeters,
      startsAtMeters: totalDistanceMeters,
    });
    totalDistanceMeters += distanceMeters;
  }

  return { segments, totalDistanceMeters };
}

function getRoutePreviewCoordinate(
  track: RoutePreviewTrack,
  distanceMeters: number,
) {
  const segment =
    track.segments.find(
      (candidate) =>
        distanceMeters <= candidate.startsAtMeters + candidate.distanceMeters,
    ) ?? track.segments[track.segments.length - 1];

  const segmentProgress = Math.min(
    Math.max(
      (distanceMeters - segment.startsAtMeters) / segment.distanceMeters,
      0,
    ),
    1,
  );

  return [
    segment.start[0] + (segment.end[0] - segment.start[0]) * segmentProgress,
    segment.start[1] + (segment.end[1] - segment.start[1]) * segmentProgress,
  ] as Coordinates;
}

export default function RoutePlanner() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const marker = useRef<Marker | null>(null);
  const routePreviewAnimation = useRef<number | null>(null);
  const [start, setStart] = useState<Coordinates | null>(null);
  const [distanceKm, setDistanceKm] = useState(5);
  const [routes, setRoutes] = useState<RouteResponse[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isPreviewingRoute, setIsPreviewingRoute] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
  const selectedRoute = routes[selectedRouteIndex] ?? null;

  const stopRoutePreview = useCallback(() => {
    if (routePreviewAnimation.current !== null) {
      cancelAnimationFrame(routePreviewAnimation.current);
      routePreviewAnimation.current = null;
    }

    setIsPreviewingRoute(false);
  }, []);

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
      stopRoutePreview();
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
  }, [accessToken, stopRoutePreview]);

  useEffect(() => {
    return () => {
      if (routePreviewAnimation.current !== null) {
        cancelAnimationFrame(routePreviewAnimation.current);
      }
    };
  }, []);

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

    stopRoutePreview();
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
        stopRoutePreview();
        setStart([position.coords.longitude, position.coords.latitude]);
        setRoutes([]);
        setSelectedRouteIndex(0);
        setError(null);
      },
      () => setError("Could not read your current location."),
      { enableHighAccuracy: true },
    );
  };

  const previewSelectedRoute = () => {
    const currentMap = map.current;

    if (!currentMap || !selectedRoute) {
      return;
    }

    const track = createRoutePreviewTrack(selectedRoute.geometry.coordinates);

    if (track.segments.length === 0 || track.totalDistanceMeters === 0) {
      return;
    }

    stopRoutePreview();
    currentMap.stop();
    setIsPreviewingRoute(true);

    const startedAt = performance.now();

    const animateRoutePreview = (timestamp: number) => {
      const progress = Math.min(
        (timestamp - startedAt) / PREVIEW_DURATION_MS,
        1,
      );
      const cameraDistance = track.totalDistanceMeters * progress;
      const cameraCoordinate = getRoutePreviewCoordinate(
        track,
        cameraDistance,
      );
      const focusCoordinate = getRoutePreviewCoordinate(
        track,
        Math.min(
          cameraDistance + PREVIEW_LOOK_AHEAD_METERS,
          track.totalDistanceMeters,
        ),
      );
      const camera = currentMap.getFreeCameraOptions();
      const cameraElevation =
        currentMap.queryTerrainElevation(cameraCoordinate) ?? 0;
      const focusElevation =
        currentMap.queryTerrainElevation(focusCoordinate) ?? 0;

      camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
        cameraCoordinate,
        cameraElevation + PREVIEW_CAMERA_ALTITUDE_METERS,
      );
      camera.lookAtPoint(
        focusCoordinate,
        DEFAULT_CAMERA_UP_VECTOR,
        focusElevation,
      );
      currentMap.setFreeCameraOptions(camera);

      if (progress < 1) {
        routePreviewAnimation.current =
          requestAnimationFrame(animateRoutePreview);
      } else {
        routePreviewAnimation.current = null;
        setIsPreviewingRoute(false);
      }
    };

    routePreviewAnimation.current =
      requestAnimationFrame(animateRoutePreview);
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
                stopRoutePreview();
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
                    onClick={() => {
                      stopRoutePreview();
                      setSelectedRouteIndex(index);
                    }}
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
              <button
                className={styles.previewButton}
                type="button"
                onClick={
                  isPreviewingRoute ? stopRoutePreview : previewSelectedRoute
                }
              >
                {isPreviewingRoute ? "Stop preview" : "Preview route in 3D"}
              </button>
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
