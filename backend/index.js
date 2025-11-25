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
  'https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/7days';
const GATEWAY_LIMIT = parseInt(process.env.GISTDA_GATEWAY_LIMIT || '10000', 10);
const GATEWAY_OFFSET = parseInt(process.env.GISTDA_GATEWAY_OFFSET || '0', 10);
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

function buildGatewayUrl(bbox, includeApiKeyAsQuery = false, offset = GATEWAY_OFFSET) {
  const url = new URL(GATEWAY_URL);
  url.searchParams.set('bbox', `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`);
  url.searchParams.set('limit', GATEWAY_LIMIT);
  url.searchParams.set('offset', offset);
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
  // Try gateway paginated
  const maxIterations = 10;
  let offset = GATEWAY_OFFSET;
  let aggregated = [];
  let aggregatedSource = null;
  for (let i = 0; i < maxIterations; i += 1) {
    const candidate = {
      url: buildGatewayUrl(bbox, GATEWAY_USE_QUERY_KEY, offset),
      label: `gateway(offset=${offset})`,
      headers: GATEWAY_USE_QUERY_KEY ? { accept: 'application/json' } : { 'API-Key': API_KEY, accept: 'application/json' }
    };
    const fc = await tryFetch(candidate);
    if (fc && fc.features?.length) {
      aggregated = aggregated.concat(fc.features);
      aggregatedSource = candidate.url;
      console.log(
        `Fetched flood data from GISTDA (${candidate.label}) with ${fc.features.length} features (agg=${aggregated.length})`
      );
      if (fc.features.length < GATEWAY_LIMIT) {
        break;
      }
      offset += GATEWAY_LIMIT;
      continue;
    }
  }

  if (aggregated.length) {
    cache.data = { type: 'FeatureCollection', features: aggregated };
    cache.fetchedAt = new Date().toISOString();
    cache.sourceUrl = aggregatedSource;
    cache.error = null;
    return;
  }

  // Fallback: open endpoint once
  const openCandidate = { url: buildUrl(OPEN_URL_TEMPLATE, bbox), label: 'open', headers: {} };
  const fcOpen = await tryFetch(openCandidate);
  if (fcOpen && fcOpen.features?.length) {
    cache.data = fcOpen;
    cache.fetchedAt = new Date().toISOString();
    cache.sourceUrl = openCandidate.url;
    cache.error = null;
    console.log(`Fetched flood data from GISTDA (${openCandidate.label})`);
    return;
  }

  cache.error = 'Unable to fetch flood data from GISTDA';
}

async function tryFetch(candidate) {
  try {
    const res = await fetch(candidate.url, {
      redirect: 'follow',
      headers: candidate.headers
    });
    if (!res.ok) {
      const body = await safeReadBody(res);
      console.warn(`GISTDA ${candidate.label} HTTP ${res.status}`, body);
      return null;
    }
    const json = await res.json();
    return normalizeGeoJson(json);
  } catch (err) {
    console.warn(`Fetch failed for ${candidate.label}`, err);
    return null;
  }
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
