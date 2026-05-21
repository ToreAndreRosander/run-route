import { NextResponse } from "next/server";

type Coordinates = [number, number];

type DirectionsRoute = {
  distance: number;
  duration: number;
  geometry: {
    type: "LineString";
    coordinates: Coordinates[];
  };
};

type DirectionsResponse = {
  routes?: DirectionsRoute[];
};

type RouteCandidate = {
  coordinates: Coordinates[];
  bearing: number;
};

const EARTH_RADIUS_METERS = 6_371_000;
const MAX_ROUTE_OPTIONS = 5;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    start?: unknown;
    distanceKm?: unknown;
  } | null;
  const start = parseCoordinates(body?.start);
  const distanceKm =
    typeof body?.distanceKm === "number" ? body.distanceKm : Number.NaN;

  if (!start || !Number.isFinite(distanceKm) || distanceKm < 2 || distanceKm > 30) {
    return NextResponse.json(
      { error: "Provide a start coordinate and a distance between 2 and 30 km." },
      { status: 400 },
    );
  }

  const accessToken =
    process.env.MAPBOX_ACCESS_TOKEN ?? process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  if (!accessToken) {
    return NextResponse.json(
      { error: "Mapbox access token is not configured." },
      { status: 500 },
    );
  }

  const targetDistanceMeters = distanceKm * 1000;
  const candidates = buildLoopCandidates(start, targetDistanceMeters);
  const routes = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      route: await fetchDirections(candidate.coordinates, accessToken),
    })),
  );
  const bestRoutes = selectRouteOptions(
    routes
      .filter(
        (
          result,
        ): result is { candidate: RouteCandidate; route: DirectionsRoute } =>
          Boolean(result.route),
      )
      .map(({ candidate, route }) => ({
        candidate,
        route,
        score: scoreRoute(route, start, targetDistanceMeters),
      }))
      .toSorted((left, right) => left.score - right.score),
  );

  if (bestRoutes.length === 0) {
    return NextResponse.json(
      { error: "Mapbox could not find a suitable running route from that point." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    routes: bestRoutes.map(({ route }, index) => ({
      id: `route-${index + 1}`,
      geometry: route.geometry,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      endDistanceMeters: haversineDistance(
        start,
        route.geometry.coordinates[route.geometry.coordinates.length - 1],
      ),
      targetDistanceMeters,
    })),
  });
}

function parseCoordinates(value: unknown): Coordinates | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }

  const [longitude, latitude] = value;
  if (
    typeof longitude !== "number" ||
    typeof latitude !== "number" ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }

  return [longitude, latitude];
}

function buildLoopCandidates(
  start: Coordinates,
  targetDistanceMeters: number,
): RouteCandidate[] {
  const sides = 5;
  const radius = targetDistanceMeters / (2 * sides * Math.sin(Math.PI / sides));
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];

  return bearings.flatMap((bearing) =>
    [1, -1].map((direction) => {
      const center = destination(start, radius, bearing + 180);
      const coordinates: Coordinates[] = [start];

      for (let index = 1; index < sides; index += 1) {
        coordinates.push(
          destination(center, radius, bearing + direction * index * (360 / sides)),
        );
      }

      coordinates.push(start);

      return { coordinates, bearing };
    }),
  );
}

function selectRouteOptions<
  T extends { candidate: RouteCandidate; route: DirectionsRoute; score: number },
>(routes: T[]) {
  const selected: T[] = [];

  for (const minimumBearingSeparation of [60, 35, 0]) {
    for (const route of routes) {
      if (
        selected.includes(route) ||
        selected.some(
          (selectedRoute) =>
            bearingSeparation(
              selectedRoute.candidate.bearing,
              route.candidate.bearing,
            ) < minimumBearingSeparation,
        )
      ) {
        continue;
      }

      selected.push(route);

      if (selected.length === MAX_ROUTE_OPTIONS) {
        return selected;
      }
    }
  }

  return selected;
}

async function fetchDirections(
  coordinates: Coordinates[],
  accessToken: string,
): Promise<DirectionsRoute | null> {
  const coordinatePath = coordinates
    .map(([longitude, latitude]) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`)
    .join(";");
  const params = new URLSearchParams({
    access_token: accessToken,
    alternatives: "false",
    geometries: "geojson",
    overview: "full",
    steps: "false",
  });
  const response = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinatePath}?${params}`,
    { next: { revalidate: 0 } },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as DirectionsResponse;
  const route = data.routes?.[0];

  if (
    !route ||
    !Number.isFinite(route.distance) ||
    !Number.isFinite(route.duration) ||
    route.geometry?.type !== "LineString" ||
    !Array.isArray(route.geometry.coordinates) ||
    route.geometry.coordinates.length < 2
  ) {
    return null;
  }

  return route;
}

function scoreRoute(
  route: DirectionsRoute,
  start: Coordinates,
  targetDistanceMeters: number,
) {
  const end = route.geometry.coordinates[route.geometry.coordinates.length - 1];
  return (
    Math.abs(route.distance - targetDistanceMeters) * 1.4 +
    haversineDistance(start, end) * 3 +
    sharpTurnPenalty(route.geometry.coordinates) +
    loopAreaPenalty(route.geometry.coordinates, start, targetDistanceMeters)
  );
}

function sharpTurnPenalty(coordinates: Coordinates[]) {
  return coordinates.reduce((penalty, coordinate, index) => {
    const previous = coordinates[index - 1];
    const next = coordinates[index + 1];

    if (
      !previous ||
      !next ||
      haversineDistance(previous, coordinate) < 25 ||
      haversineDistance(coordinate, next) < 25
    ) {
      return penalty;
    }

    const turnAngle = bearingSeparation(
      bearingBetween(previous, coordinate),
      bearingBetween(coordinate, next),
    );

    if (turnAngle < 135) {
      return penalty;
    }

    return penalty + (turnAngle - 135) ** 2 * 2 + (turnAngle > 165 ? 2_000 : 0);
  }, 0);
}

function loopAreaPenalty(
  coordinates: Coordinates[],
  start: Coordinates,
  targetDistanceMeters: number,
) {
  const minimumLoopArea = targetDistanceMeters ** 2 * 0.012;
  const area = enclosedArea(coordinates, start);

  return Math.max(0, minimumLoopArea - area) / 20;
}

function enclosedArea(coordinates: Coordinates[], origin: Coordinates) {
  const projected = coordinates.map((coordinate) => project(coordinate, origin));
  const doubleArea = projected.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = projected[(index + 1) % projected.length];

    return sum + x * nextY - nextX * y;
  }, 0);

  return Math.abs(doubleArea) / 2;
}

function project(
  [longitude, latitude]: Coordinates,
  [originLongitude, originLatitude]: Coordinates,
) {
  const x =
    toRadians(longitude - originLongitude) *
    EARTH_RADIUS_METERS *
    Math.cos(toRadians(originLatitude));
  const y = toRadians(latitude - originLatitude) * EARTH_RADIUS_METERS;

  return [x, y];
}

function bearingBetween(
  [startLongitude, startLatitude]: Coordinates,
  [endLongitude, endLatitude]: Coordinates,
) {
  const startLatitudeRadians = toRadians(startLatitude);
  const endLatitudeRadians = toRadians(endLatitude);
  const longitudeDelta = toRadians(endLongitude - startLongitude);
  const y = Math.sin(longitudeDelta) * Math.cos(endLatitudeRadians);
  const x =
    Math.cos(startLatitudeRadians) * Math.sin(endLatitudeRadians) -
    Math.sin(startLatitudeRadians) *
      Math.cos(endLatitudeRadians) *
      Math.cos(longitudeDelta);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function bearingSeparation(left: number, right: number) {
  const difference = Math.abs(left - right) % 360;

  return difference > 180 ? 360 - difference : difference;
}

function destination(
  [longitude, latitude]: Coordinates,
  distanceMeters: number,
  bearingDegrees: number,
): Coordinates {
  const bearing = toRadians(bearingDegrees);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitudeRadians = toRadians(latitude);
  const longitudeRadians = toRadians(longitude);
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    );

  return [toDegrees(nextLongitude), toDegrees(nextLatitude)];
}

function haversineDistance(
  [startLongitude, startLatitude]: Coordinates,
  [endLongitude, endLatitude]: Coordinates,
) {
  const latitudeDelta = toRadians(endLatitude - startLatitude);
  const longitudeDelta = toRadians(endLongitude - startLongitude);
  const startLatitudeRadians = toRadians(startLatitude);
  const endLatitudeRadians = toRadians(endLatitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitudeRadians) *
      Math.cos(endLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number) {
  return (radians * 180) / Math.PI;
}
