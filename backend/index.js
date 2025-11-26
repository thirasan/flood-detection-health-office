import http from 'http';

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.GISTDA_API_KEY || '';

const PROVINCES = [
  {
    id: 'surat-thani',
    th: 'สุราษฎร์ธานี',
    bbox: { minX: 98.72, minY: 7.78, maxX: 100.15, maxY: 10.33 }
  },
  {
    id: 'nakhon-si-thammarat',
    th: 'นครศรีธรรมราช',
    bbox: { minX: 99.3, minY: 7.75, maxX: 100.3, maxY: 9.5 }
  },
  {
    id: 'phatthalung',
    th: 'พัทลุง',
    bbox: { minX: 99.73, minY: 7.08, maxX: 100.42, maxY: 7.92 }
  },
  {
    id: 'songkhla',
    th: 'สงขลา',
    bbox: { minX: 100.02, minY: 6.28, maxX: 101.1, maxY: 7.93 }
  },
  {
    id: 'narathiwat',
    th: 'นราธิวาส',
    bbox: { minX: 101.33, minY: 5.75, maxX: 102.08, maxY: 6.5 }
  }
];

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

function buildGatewayUrl(bbox, includeApiKeyAsQuery = false, offset = GATEWAY_OFFSET, limit = GATEWAY_LIMIT) {
  const url = new URL(GATEWAY_URL);
  url.searchParams.set('bbox', `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`);
  url.searchParams.set('limit', limit);
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

  const agg = await fetchAllProvinces();
  if (agg.features.length) {
    cache.data = agg;
    cache.fetchedAt = new Date().toISOString();
    cache.sourceUrl = 'gateway-multi';
    cache.error = null;
    return;
  }

  cache.error = 'Unable to fetch flood data from GISTDA';
}

async function fetchAllProvinces() {
  let allFeatures = [];
  for (const prov of PROVINCES) {
    const fc = await fetchProvince(prov);
    if (fc?.features?.length) {
      const withProv = fc.features.map((feat) => ({
        ...feat,
        properties: { ...(feat.properties || {}), province: prov.id, province_th: prov.th }
      }));
      allFeatures = allFeatures.concat(withProv);
    }
  }
  console.log(`Finished fetching provinces. Total features: ${allFeatures.length}`);
  return { type: 'FeatureCollection', features: allFeatures };
}

async function fetchProvince(prov) {
  const limit = GATEWAY_LIMIT;
  let offset = GATEWAY_OFFSET;
  let total = null;
  let agg = [];
  const maxIterations = 50;

  for (let i = 0; i < maxIterations; i += 1) {
    const url = buildGatewayUrl(prov.bbox, GATEWAY_USE_QUERY_KEY, offset, limit);
    const headers = GATEWAY_USE_QUERY_KEY ? { accept: 'application/json' } : { 'API-Key': API_KEY, accept: 'application/json' };
    const fc = await tryFetch({ url, label: `${prov.id}[${offset}]`, headers });
    if (!fc || !fc.features) break;

    agg = agg.concat(fc.features);

    // Determine total if available in response
    total =
      total ||
      fc.total ||
      fc.totalFeatures ||
      fc.count ||
      fc.numberMatched ||
      fc.features.length;

    if (fc.features.length < limit) break;
    if (total && offset + limit >= total) break;
    offset += limit;
  }

  return { type: 'FeatureCollection', features: agg };
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
  if (Array.isArray(data)) return { type: 'FeatureCollection', features: data };
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
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (urlObj.pathname.startsWith('/api/flood') && (req.method === 'GET' || req.method === 'POST')) {
    const province = urlObj.searchParams.get('province');
    const limit = Math.max(1, parseInt(urlObj.searchParams.get('limit') || '500', 10));
    const offset = Math.max(0, parseInt(urlObj.searchParams.get('offset') || '0', 10));

    if (cache.data) {
      const filtered =
        province && province !== 'all'
          ? cache.data.features.filter(
              (f) => f.properties?.province === province || f.properties?.province_th === province
            )
          : cache.data.features;

      const sliced = filtered.slice(offset, offset + limit);
      const data = { type: 'FeatureCollection', features: sliced };

      return sendJson(res, 200, {
        status: 'ok',
        fetchedAt: cache.fetchedAt,
        sourceUrl: cache.sourceUrl,
        features: data.features.length,
        total: filtered.length,
        data
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
