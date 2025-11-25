import http from 'http';

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.GISTDA_API_KEY || '';

const DEFAULT_BBOX = {
  minX: parseFloat(process.env.BBOX_MINX || '100.02'),
  minY: parseFloat(process.env.BBOX_MINY || '6.28'),
  maxX: parseFloat(process.env.BBOX_MAXX || '101.10'),
  maxY: parseFloat(process.env.BBOX_MAXY || '7.93')
};

const OPEN_URL_TEMPLATE =
  process.env.GISTDA_URL_TEMPLATE ||
  'https://disaster.gistda.or.th/services/get_features_flood_7days?token={API_KEY}&bbox={MINX},{MINY},{MAXX},{MAXY}';

const GATEWAY_URL =
  process.env.GISTDA_GATEWAY_URL ||
  'https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/7days?api_key={API_KEY}';
const GATEWAY_LIMIT = process.env.GISTDA_GATEWAY_LIMIT || '10000';
const GATEWAY_OFFSET = process.env.GISTDA_GATEWAY_OFFSET || '0';
const GATEWAY_USE_QUERY_KEY = process.env.GISTDA_GATEWAY_USE_QUERY_KEY === 'true';
const REFRESH_MS = 360 * 60 * 1000; // 5 นาที

const cache = {
  data: null,
  fetchedAt: null,
  sourceUrl: null,
  error: null
};

function buildUrl(template, bbox) {
  return template
    .replace('{API_KEY}', encodeURIComponent(API_KEY))
    .replace('{MINX}', bbox.minX)
    .replace('{MINY}', bbox.minY)
    .replace('{MAXX}', bbox.maxX)
    .replace('{MAXY}', bbox.maxY);
}

function buildGatewayUrl(bbox, includeApiKeyAsQuery = false) {
  const url = new URL(GATEWAY_URL);
  url.searchParams.set('bbox', `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`);
  url.searchParams.set('limit', GATEWAY_LIMIT);
  url.searchParams.set('offset', GATEWAY_OFFSET);
  if (includeApiKeyAsQuery || GATEWAY_USE_QUERY_KEY) {
    url.searchParams.set('apikey', API_KEY);
  }
  return url.toString();
}

async function fetchFlood() {
  if (!API_KEY) {
    cache.error = 'GISTDA_API_KEY is missing';
    console.warn(cache.error);
    return;
  }

  const bbox = DEFAULT_BBOX;
  const candidates = [
    {
      url: buildGatewayUrl(bbox),
      label: 'gateway',
      headers: { 'API-Key': API_KEY, accept: 'application/json' }
    },
    {
      url: buildGatewayUrl(bbox, true),
      label: 'gateway-query',
      headers: { accept: 'application/json' }
    },
    { url: buildUrl(OPEN_URL_TEMPLATE, bbox), label: 'open', headers: {} }
  ];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, {
        redirect: 'follow',
        headers: candidate.headers
      });
      if (!res.ok) {
        const body = await safeReadBody(res);
        console.warn(`GISTDA ${candidate.label} HTTP ${res.status}`, body);
        continue;
      }
      const json = await res.json();
      const fc = normalizeGeoJson(json);
      cache.data = fc;
      cache.fetchedAt = new Date().toISOString();
      cache.sourceUrl = candidate.url;
      cache.error = null;
      console.log(`Fetched flood data from GISTDA (${candidate.label})`);
      return;
    } catch (err) {
      console.warn(`Fetch failed for ${candidate.label}`, err);
    }
  }

  cache.error = 'Unable to fetch flood data from GISTDA';
}

function normalizeGeoJson(data) {
  if (data?.type === 'FeatureCollection') return data;
  if (Array.isArray(data?.features)) {
    return { type: 'FeatureCollection', features: data.features };
  }
  throw new Error('Response is not a GeoJSON FeatureCollection');
}

async function safeReadBody(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.url.startsWith('/api/flood') && (req.method === 'GET' || req.method === 'POST')) {
    if (cache.data) {
      return sendJson(res, 200, {
        status: 'ok',
        fetchedAt: cache.fetchedAt,
        sourceUrl: cache.sourceUrl,
        features: cache.data.features?.length || 0,
        data: cache.data
      });
    }
    return sendJson(res, 503, { status: 'error', error: cache.error || 'Data not available' });
  }

  res.writeHead(404, {
    'Access-Control-Allow-Origin': '*'
  });
  res.end('Not found');
}

function startServer() {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

// Initial fetch then interval
fetchFlood();
setInterval(fetchFlood, REFRESH_MS);
startServer();
