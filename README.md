# Run Route

A Next.js web app for finding approximate running loops with Mapbox APIs.

## Getting started

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Set Mapbox tokens before using the map and route generation:

```bash
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=your-public-mapbox-token
MAPBOX_ACCESS_TOKEN=your-mapbox-token
```

`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` enables the interactive Mapbox map in the
browser. `MAPBOX_ACCESS_TOKEN` is used by the server route that calls Mapbox
Directions; if it is not set, the server falls back to the public token.

## Scripts

- `npm run lint` checks the app with ESLint.
- `npm run build` creates a production Next.js build.
