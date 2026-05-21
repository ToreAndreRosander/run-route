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

const EARTH_RADIUS_METERS = 6_371_000;

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
    candidates.map((candidate) => fetchDirections(candidate, accessToken)),
  );
  const bestRoute = routes
    .filter((route): route is DirectionsRoute => Boolean(route))
    .toSorted(
      (left, right) =>
        scoreRoute(left, start, targetDistanceMeters) -
        scoreRoute(right, start, targetDistanceMeters),
    )[0];

  if (!bestRoute) {
    return NextResponse.json(
      { error: "Mapbox could not find a suitable running route from that point." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    geometry: bestRoute.geometry,
    distanceMeters: bestRoute.distance,
    durationSeconds: bestRoute.duration,
    endDistanceMeters: haversineDistance(
      start,
      bestRoute.geometry.coordinates[bestRoute.geometry.coordinates.length - 1],
    ),
    targetDistanceMeters,
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

function buildLoopCandidates(start: Coordinates, targetDistanceMeters: number) {
  const radius = targetDistanceMeters / (2 + Math.sqrt(3));
  return [0, 45, 90, 135, 180, 225, 270, 315].map((bearing) => [
    start,
    destination(start, radius, bearing),
    destination(start, radius, bearing + 120),
    start,
  ]);
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
    Math.abs(route.distance - targetDistanceMeters) + haversineDistance(start, end) * 2
  );
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
