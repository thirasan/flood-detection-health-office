# Flood Backend (GISTDA proxy)

Simple Node.js service that fetches GISTDA flood polygons every 5 minutes and exposes them with CORS at `/api/flood`.

## Run
```bash
cd backend
GISTDA_API_KEY=your_key_here \
PORT=4000 \
node index.js
```

Optional env:
- `GISTDA_URL_TEMPLATE` (open endpoint)
- `GISTDA_GATEWAY_URL_TEMPLATE` (gateway with `apikey=` in query)
- `BBOX_MINX/BBOX_MINY/BBOX_MAXX/BBOX_MAXY` (defaults to Hat Yai)

## Response
`GET /api/flood` -> `{ status, fetchedAt, sourceUrl, features, data: <FeatureCollection> }`
