"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import mapboxgl, {
  GeoJSONSource,
  LngLatLike,
  Map as MapboxMap,
  Marker,
} from "mapbox-gl";
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
const PREVIEW_CAMERA_ALTITUDE_METERS = 350;
const PREVIEW_SPEED_METERS_PER_SECOND = 1;
const PREVIEW_MIN_DURATION_MS = 7000;
const PREVIEW_MAX_DURATION_MS = 18000;
const PREVIEW_LOOK_AHEAD_METERS = 250;
const PREVIEW_MAX_LOOK_AHEAD_METERS = 500;
const PREVIEW_TILT_DEGREES = 68;
const PREVIEW_FOCUS_SMOOTHING_PER_SECOND = 50;
const AUTOMATIC_CAMERA_UP_VECTOR = undefined;
const EARTH_RADIUS_METERS = 6371000;

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
    EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}

function createRoutePreviewTrack(coordinates: GeoJSON.Position[]) {
  const routeCoordinates = coordinates.map(
    (coordinate) => [coordinate[0], coordinate[1]] as Coordinates,
  );
  const segments: RoutePreviewSegment[] = [];
  let totalDistanceMeters = 0;

  for (
    let segmentIndex = 1;
    segmentIndex < routeCoordinates.length;
    segmentIndex += 1
  ) {
    const start = routeCoordinates[segmentIndex - 1];
    const end = routeCoordinates[segmentIndex];
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
  let low = 0;
  let high = track.segments.length - 1;

  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    const midpointSegment = track.segments[midpoint];

    if (
      distanceMeters <=
      midpointSegment.startsAtMeters + midpointSegment.distanceMeters
    ) {
      high = midpoint;
    } else {
      low = midpoint + 1;
    }
  }

  const segment = track.segments[low];

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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function interpolateCoordinates(
  start: Coordinates,
  end: Coordinates,
  factor: number,
): Coordinates {
  return [
    start[0] + (end[0] - start[0]) * factor,
    start[1] + (end[1] - start[1]) * factor,
  ];
}

export default function RoutePlanner() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
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
      pitch: 55,
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
      setError("Velg først et startpunkt på kartet.");
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
        throw new Error("error" in data ? data.error : "Kunne ikke finne en rute.");
      }

      const routeOptions = (data as RoutesResponse).routes;
      if (!Array.isArray(routeOptions) || routeOptions.length === 0) {
        throw new Error("Kunne ikke finne en rute.");
      }

      setRoutes(routeOptions);
      setSelectedRouteIndex(0);
    } catch (nextError) {
      setRoutes([]);
      setSelectedRouteIndex(0);
      setError(
        nextError instanceof Error ? nextError.message : "Kunne ikke finne en rute.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError("Nettleseren din støtter ikke geolokasjon.");
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
      () => setError("Kunne ikke hente posisjonen din."),
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

    const previewDurationMs = clamp(
      (track.totalDistanceMeters / PREVIEW_SPEED_METERS_PER_SECOND) * 1000,
      PREVIEW_MIN_DURATION_MS,
      PREVIEW_MAX_DURATION_MS,
    );
    const previewLookAheadMeters = clamp(
      PREVIEW_CAMERA_ALTITUDE_METERS * Math.tan(toRadians(PREVIEW_TILT_DEGREES)),
      PREVIEW_LOOK_AHEAD_METERS,
      PREVIEW_MAX_LOOK_AHEAD_METERS,
    );
    const startedAt = performance.now();
    let previousFrameTimestamp = startedAt;
    let smoothedFocusCoordinate: Coordinates | null = null;
    const usesTerrain = Boolean(currentMap.getTerrain());
    const terrainElevationByCoordinate = new Map<string, number>();
    const getPreviewElevation = (coordinate: Coordinates) => {
      if (!usesTerrain) {
        return 0;
      }

      const coordinateKey = `${coordinate[0].toFixed(4)},${coordinate[1].toFixed(
        4,
      )}`;
      const cachedElevation = terrainElevationByCoordinate.get(coordinateKey);

      if (cachedElevation !== undefined) {
        return cachedElevation;
      }

      const elevation = currentMap.queryTerrainElevation(coordinate) ?? 0;
      terrainElevationByCoordinate.set(coordinateKey, elevation);

      return elevation;
    };

    const animateRoutePreview = (timestamp: number) => {
      const progress = Math.min(
        (timestamp - startedAt) / previewDurationMs,
        1,
      );
      const cameraDistance = track.totalDistanceMeters * progress;
      const cameraCoordinate = getRoutePreviewCoordinate(
        track,
        cameraDistance,
      );
      const rawFocusCoordinate = getRoutePreviewCoordinate(
        track,
        Math.min(
          cameraDistance + previewLookAheadMeters,
          track.totalDistanceMeters,
        ),
      );
      const deltaSeconds = Math.max(timestamp - previousFrameTimestamp, 0) / 1000;
      previousFrameTimestamp = timestamp;
      const smoothingFactor = clamp(
        1 -
          Math.exp(
            -PREVIEW_FOCUS_SMOOTHING_PER_SECOND * deltaSeconds,
          ),
        0,
        1,
      );

      smoothedFocusCoordinate = smoothedFocusCoordinate
        ? interpolateCoordinates(
            smoothedFocusCoordinate,
            rawFocusCoordinate,
            smoothingFactor,
          )
        : rawFocusCoordinate;
      const camera = currentMap.getFreeCameraOptions();
      const cameraElevation = getPreviewElevation(cameraCoordinate);
      const focusElevation = getPreviewElevation(smoothedFocusCoordinate);

      camera.position = mapboxgl.MercatorCoordinate.fromLngLat(
        cameraCoordinate,
        cameraElevation + PREVIEW_CAMERA_ALTITUDE_METERS,
      );
      camera.lookAtPoint(
        smoothedFocusCoordinate,
        AUTOMATIC_CAMERA_UP_VECTOR,
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
          <p className={styles.eyebrow}>Rutefinner drevet av Mapbox</p>
          <h1>Finn en løperute fra hvor som helst.</h1>
          <p className={styles.lead}>
            Velg et startpunkt, omtrent hvor langt du vil løpe, og Run Route
            finner en rundløype som slutter nær der du startet.
          </p>
        </div>
      </section>

      <section className={styles.planner}>
        <div className={styles.mapPanel}>
          <div ref={mapContainer} className={styles.map} aria-label="Kart">
            {!accessToken && (
              <div className={styles.mapFallback}>
                Legg til <code>NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code> for å
                aktivere det interaktive Mapbox-kartet.
              </div>
            )}
          </div>
        </div>

        <form className={styles.controls} onSubmit={handleSubmit}>
          <h2>Planlegg løpeturen</h2>
          <p>
            Trykk på kartet eller bruk posisjonen i nettleseren for å sette
            startpunktet.
          </p>
{selectedRoute && (
            <div className={styles.result}>
              <h3>Valgt rute</h3>
              <button
                className={styles.previewButton}
                type="button"
                onClick={
                  isPreviewingRoute ? stopRoutePreview : previewSelectedRoute
                }
              >
                {isPreviewingRoute
                  ? "Stopp forhåndsvisning"
                  : "Forhåndsvis ruten i 3D"}
              </button>
              <dl>
                <div>
                  <dt>Distanse</dt>
                  <dd>{(selectedRoute.distanceMeters / 1000).toFixed(2)} km</dd>
                </div>
                
                
              </dl>
            </div>
          )}

          <button
            className={styles.secondaryButton}
            type="button"
            onClick={useCurrentLocation}
          >
            Bruk posisjonen min
          </button>

          <label className={styles.field}>
            Startpunkt
            <span className={styles.coordinates}>
              {start
                ? `${start[1].toFixed(5)}, ${start[0].toFixed(5)}`
                : "Ingen punkt valgt"}
            </span>
          </label>

          <label className={styles.field}>
            Omtrentlig distanse: {distanceKm} km
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
            {isLoading ? "Finner rute..." : "Finn rute"}
          </button>

          
          {error && <p className={styles.error}>{error}</p>}

          {routes.length > 0 && (
            <div className={styles.routeOptions}>
              <h3>Velg en rute</h3>
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
                    <span>Alternativ {index + 1}</span>
                    <strong>{(routeOption.distanceMeters / 1000).toFixed(2)} km</strong>
                    <small>{Math.round(routeOption.durationSeconds / 60)} min</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
