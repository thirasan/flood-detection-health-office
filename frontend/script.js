const mapCenter = [7.005, 100.49];
const zoomLevel = 12.6;
const REFRESH_MS = 30 * 60 * 1000; // 30 นาที
const config = window.appConfig || {};
const provinceNameMap = {
  'surat-thani': 'สุราษฎร์ธานี',
  'nakhon-si-thammarat': 'นครศรีธรรมราช',
  phatthalung: 'พัทลุง',
  songkhla: 'สงขลา',
  narathiwat: 'นราธิวาส',
  unknown: 'ไม่ทราบ'
};
const provinceSlugMap = {
  สุราษฎร์ธานี: 'surat-thani',
  นครศรีธรรมราช: 'nakhon-si-thammarat',
  พัทลุง: 'phatthalung',
  สงขลา: 'songkhla',
  นราธิวาส: 'narathiwat'
};

let map;
let floodLayer;
let markerGroup;
let facilities = [];
let floodGeojson;
let floodCache = {};
let lastProvinceFetched = null;
let computedFacilities = [];
let markerIndex = new Map();
let autoRefreshId = null;
let isLoading = false;
let selectedProvince = 'สงขลา';
let selectedType = 'คลินิกทันตกรรม';

const statusConfig = {
  flooded: { label: 'น้ำท่วม', badgeClass: 'badge--danger', color: '#ef4444' },
  high: { label: 'เสี่ยงสูง', badgeClass: 'badge--warning', color: '#f97316' },
  medium: { label: 'เฝ้าระวัง', badgeClass: 'badge--watch', color: '#eab308' },
  low: { label: 'ปลอดภัย', badgeClass: 'badge--safe', color: '#22c55e' },
  nodata: { label: 'ไม่มีข้อมูลน้ำท่วม', badgeClass: 'badge--watch', color: '#94a3b8' }
};

document.addEventListener('DOMContentLoaded', () => {
  setupMap();
  bindControls();
  refreshData();
  startAutoRefresh();
});

function setupMap() {
  map = L.map('map', { zoomControl: true }).setView(mapCenter, zoomLevel);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  markerGroup = L.layerGroup().addTo(map);
}

function bindControls() {
  document.getElementById('refresh-btn').addEventListener('click', () => refreshData(true));
  document.getElementById('risk-filter').addEventListener('change', () => rerenderFiltered());
  const provinceSelect = document.getElementById('province-filter');
  const typeSelect = document.getElementById('type-filter');
  if (provinceSelect) {
    provinceSelect.addEventListener('change', (e) => {
      selectedProvince = e.target.value || 'all';
      updateProvinceLabel();
      refreshData(true);
    });
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
      selectedType = e.target.value || 'all';
      withRenderLoading(() => calculateAndRender());
    });
  }
}

function startAutoRefresh() {
  if (autoRefreshId) clearInterval(autoRefreshId);
  autoRefreshId = setInterval(() => refreshData(false), REFRESH_MS);
}

async function refreshData(manual = false) {
  if (isLoading) return;
  setLoading(true);
  setRenderLoading(true);
  let facilityData = facilities;
  let floodData = floodGeojson;
  let errorMsg = '';
  try {
    try {
      facilityData = await loadFacilityData();
    } catch (err) {
      console.error('โหลดสถานพยาบาลล้มเหลว', err);
      errorMsg = 'โหลดข้อมูลสถานพยาบาลไม่สำเร็จ';
    }
    try {
      floodData = await loadFloodData();
    } catch (err) {
      console.error('โหลดน้ำท่วมล้มเหลว', err);
      errorMsg = errorMsg || 'โหลดข้อมูลน้ำท่วมไม่สำเร็จ';
    }

    facilities = Array.isArray(facilityData) ? facilityData : [];
    setFilterOptions(facilities);
    floodGeojson = normalizeFlood(floodData);
    calculateAndRender();
  } catch (err) {
    console.error('คำนวณผลล้มเหลว', err);
    errorMsg = errorMsg || 'คำนวณผลไม่สำเร็จ';
  } finally {
    setLastUpdated(manual, !!errorMsg);
    showError(errorMsg);
    setLoading(false);
    setRenderLoading(false);
  }
}

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`โหลดข้อมูลล้มเหลว: ${path}`);
  return res.json();
}

async function loadFloodData() {
  // 1) เรียก backend ภายใน (หลีกเลี่ยง CORS/GISTDA redirect)
  const backendBase = (config.backendBaseUrl || 'http://localhost:4000').replace(/\/$/, '');
  const provinceSlug =
    selectedProvince === 'all'
      ? ''
      : provinceSlugMap[selectedProvince] || provinceSlugMap[selectedProvince?.trim()] || '';
  const limit = 500;
  let offset = 0;
  let aggregated = [];
  const maxPages = 20;

  // reuse cache if province not changed
  const cacheKey = provinceSlug || 'all';
  if (cacheKey === lastProvinceFetched && floodCache[cacheKey]) {
    return floodCache[cacheKey];
  }

  try {
    for (let i = 0; i < maxPages; i += 1) {
      const qs = new URLSearchParams();
      if (provinceSlug) qs.set('province', provinceSlug);
      qs.set('limit', String(limit));
      qs.set('offset', String(offset));
      const backendUrl = `${backendBase}/api/flood?${qs.toString()}`;
      const res = await fetch(backendUrl, {
        mode: 'cors',
        method: 'GET',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} จาก backend`);
      const payload = await res.json();
      const dataset = normalizeFlood(payload?.data || payload);
      aggregated = aggregated.concat(dataset.features || []);
      if (dataset.features.length < limit) break;
      offset += limit;
    }
    if (aggregated.length > 0) {
      const finalFc = { type: 'FeatureCollection', features: aggregated };
      setSourceLabel(true, `${backendBase}/api/flood`, true);
      floodCache[cacheKey] = finalFc;
      lastProvinceFetched = cacheKey;

      console.log('Flood features loaded:', finalFc.features.length);
      return finalFc;
    }
    throw new Error('backend ส่งข้อมูลแต่ไม่มีโพลิกอน');
  } catch (err) {
    console.warn('โหลดจาก backend ไม่สำเร็จ', err);
  }
  setSourceLabel(false);
  throw new Error('โหลดข้อมูลน้ำท่วมไม่สำเร็จ');
}

async function loadFacilityData() {
  const primary = config.facilitySourceUrl;
  if (!primary) throw new Error('ไม่พบแหล่งข้อมูลสถานพยาบาล');
  return loadJSON(primary);
}

function calculateAndRender() {
  if (!floodGeojson) {
    floodGeojson = { type: 'FeatureCollection', features: [] };
  }
  MAX_RENDER_FACILITIES = 2000

  const hasFlood = Array.isArray(floodGeojson.features) && floodGeojson.features.length > 0;

  const filteredFacilities = facilities.filter(filterFacilities).slice(0, MAX_RENDER_FACILITIES);

  const enriched = filteredFacilities.map((facility) => {
    const point = turf.point([facility.lng, facility.lat]);
    const { distanceKm, inside } = hasFlood
      ? findNearestFloodDistance(point, floodGeojson.features)
      : { distanceKm: Number.POSITIVE_INFINITY, inside: false };
    const statusKey = classifyRisk(distanceKm, inside, hasFlood);
    return { ...facility, distanceKm, statusKey };
  });

  computedFacilities = enriched;
  renderFloodLayer();
  renderMarkers(enriched);
  renderTable(enriched);
}

function rerenderFiltered() {
  const filtered = computedFacilities.filter(filterFacilities);
  renderMarkers(filtered);
  renderTable(filtered);
}

function normalizeProvince(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  // Map Thai province names to slugs when possible to compare consistently
  return (provinceSlugMap[trimmed] || trimmed).toLowerCase();
}

function filterFacilities(facility) {
  const matchesType = selectedType === 'all' || facility.type === selectedType;
  const selectedProv = normalizeProvince(selectedProvince);
  const facilityProv = normalizeProvince(facility.province);
  const matchesProvince = selectedProv === 'all' || !selectedProv || facilityProv === selectedProv;
  return matchesType && matchesProvince;
}

function findNearestFloodDistance(point, floodFeatures) {
  if (!Array.isArray(floodFeatures) || floodFeatures.length === 0) {
    return { distanceKm: Number.POSITIVE_INFINITY, inside: false };
  }
  const validFeatures = floodFeatures.filter(
    (f) =>
      f &&
      f.geometry &&
      Array.isArray(f.geometry.coordinates) &&
      f.geometry.coordinates.length > 0
  );
  if (validFeatures.length === 0) return { distanceKm: Number.POSITIVE_INFINITY, inside: false };

  let shortest = Number.POSITIVE_INFINITY;
  let inside = false;

  turf.flattenEach({ type: 'FeatureCollection', features: validFeatures }, (feature) => {
    try {
      if (turf.booleanPointInPolygon(point, feature)) {
        inside = true;
        shortest = 0;
        return;
      }
      const boundaryLine = turf.polygonToLine(feature);
      const distance = turf.pointToLineDistance(point, boundaryLine, { units: 'kilometers' });
      if (Number.isFinite(distance) && distance < shortest) shortest = distance;
    } catch (err) {
    }
  });

  if (!Number.isFinite(shortest)) {
    shortest = Number.POSITIVE_INFINITY;
  }
  return { distanceKm: shortest, inside };
}

function classifyRisk(distanceKm, inside, hasFlood = true) {
  if (!hasFlood) return 'nodata';
  if (inside || distanceKm === 0) return 'flooded';
  if (!Number.isFinite(distanceKm)) return 'low';
  if (distanceKm < 3) return 'high';
  if (distanceKm < 10) return 'medium';
  return 'low';
}

function renderFloodLayer() {
  if (!floodGeojson?.features || floodGeojson.features.length === 0) {
    return;
  }
  if (floodLayer) floodLayer.remove();
  floodLayer = L.geoJSON(floodGeojson, {
    style: {
      color: '#38bdf8',
      weight: 2,
      fillColor: '#38bdf8',
      fillOpacity: 0.28
    }
  }).addTo(map);
  const bounds = floodLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [12, 12] });
  } else {
    map.setView(mapCenter, zoomLevel);
  }
}

function renderMarkers(data) {
  markerGroup.clearLayers();
  markerIndex.clear();

  data.forEach((facility) => {
    const config = statusConfig[facility.statusKey];
    const marker = L.circleMarker([facility.lat, facility.lng], {
      radius: 8,
      color: 'rgba(255, 255, 255, 0.15)',
      weight: 1.5,
      fillColor: config.color,
      fillOpacity: 0.95
    });

    const popup = `
      <div class="popup">
        <strong>${facility.name_th}</strong><br/>
        <small>${facility.type}</small><br/>
        <span>${statusConfig[facility.statusKey]?.label || ''}</span>
      </div>
    `;

    marker.bindPopup(popup);
    markerGroup.addLayer(marker);
    markerIndex.set(facility.id, marker);
  });
}

function renderTable(data = computedFacilities) {
  const tbody = document.getElementById('facility-rows');
  const filter = document.getElementById('risk-filter').value;
  tbody.innerHTML = '';

  const sorted = [...data].sort((a, b) => a.distanceKm - b.distanceKm);
  const filtered = sorted.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'flooded') return item.statusKey === 'flooded';
    if (filter === 'high') return item.statusKey === 'high';
    if (filter === 'medium') return item.statusKey === 'medium';
    if (filter === 'low') return item.statusKey === 'low';
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">ไม่มีข้อมูลตามตัวกรอง</td></tr>';
    return;
  }

  filtered.forEach((facility) => {
    const status = statusConfig[facility.statusKey];
    const row = document.createElement('tr');

    row.innerHTML = `
      <td>
        <div><strong>${facility.name_th}</strong></div>
        <div class="distance">${facility.type}</div>
      </td>
      <td class="numeric distance">${formatDistance(facility.distanceKm)}</td>
      <td class="numeric">
        <span class="badge ${status.badgeClass}">${status.label}</span>
      </td>
    `;

    row.addEventListener('mouseenter', () => highlightMarker(facility));
    row.addEventListener('mouseleave', () => resetMarker(facility));
    tbody.appendChild(row);
  });
}

function highlightMarker(facility) {
  const marker = markerIndex.get(facility.id);
  if (!marker) return;
  marker.setStyle({ weight: 3 });
  marker.openPopup();
}

function resetMarker(facility) {
  const marker = markerIndex.get(facility.id);
  if (!marker) return;
  marker.setStyle({ weight: 1.5 });
}

function formatDistance(distanceKm) {
  if (!Number.isFinite(distanceKm)) return 'ไม่ทราบ';
  if (distanceKm === 0) return 'อยู่ในพื้นที่น้ำท่วม';
  if (distanceKm < 0.05) return '< 50 เมตร';
  return `${distanceKm.toFixed(2)} กม.`;
}

function setLastUpdated(manual = false, hasError = false) {
  const el = document.getElementById('last-updated');
  const date = new Date();
  const formatted = date.toLocaleString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short'
  });
  const status = hasError ? ' (ไม่สำเร็จ)' : manual ? ' (รีเฟรช)' : '';
  el.textContent = `อัปเดตล่าสุด: ${formatted}${status}`;
}

function setLoading(state) {
  isLoading = state;
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.disabled = state;
  btn.textContent = state ? 'กำลังดึงข้อมูล…' : 'รีเฟรชข้อมูล';
}

function setRenderLoading(state) {
  ['map-loading', 'table-loading'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = state ? 'flex' : 'none';
  });
}

function withRenderLoading(fn) {
  setRenderLoading(true);
  try {
    fn();
  } finally {
    setRenderLoading(false);
  }
}

function setSourceLabel(connected, url, isPrimary) {
  const el = document.getElementById('source-label');
  if (!el) return;
  if (!connected) {
    el.textContent = 'แหล่งข้อมูล: ยังไม่เชื่อมต่อ';
    el.className = 'pill pill--fallback';
    return;
  }
  el.textContent = isPrimary ? `ข้อมูลสด` : `ข้อมูลสด`;
  el.className = `pill ${isPrimary ? 'pill--live' : 'pill--fallback'}`;
}

function setFilterOptions(facilityData) {
  const provinceSelect = document.getElementById('province-filter');
  const typeSelect = document.getElementById('type-filter');
  if (provinceSelect) {
    const provinces = Array.from(new Set(facilityData.map((f) => f.province).filter(Boolean))).sort();
    provinceSelect.innerHTML =
      '<option value="all">ทุกจังหวัด</option>' +
      provinces.map((p) => `<option value="${p}">${provinceNameMap[p] || p}</option>`).join('');
    if (!selectedProvince || (!provinces.includes(selectedProvince) && selectedProvince !== 'all')) {
      selectedProvince = provinces.includes('สงขลา') ? 'สงขลา' : provinces[0] || 'all';
    }
    provinceSelect.value = selectedProvince;
    updateProvinceLabel();
  }
  if (typeSelect) {
    const types = Array.from(new Set(facilityData.map((f) => f.type).filter(Boolean))).sort();
    typeSelect.innerHTML =
      '<option value="all">ทุกประเภท</option>' +
      types.map((t) => `<option value="${t}">${t}</option>`).join('');
    if (!selectedType || (!types.includes(selectedType) && selectedType !== 'all')) {
      selectedType = types.includes('คลินิกทันตกรรม') ? 'คลินิกทันตกรรม' : 'all';
    }
    typeSelect.value = selectedType;
  }
}

function showError(message) {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  if (message) {
    banner.style.display = 'block';
    banner.textContent = message;
  } else {
    banner.style.display = 'none';
    banner.textContent = '';
  }
}

function normalizeFlood(data) {
  const empty = { type: 'FeatureCollection', features: [] };
  if (!data) return empty;
  const pick = (features) =>
    features
      .map((f) => toPolygonFeature(f))
      .filter(Boolean);

  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    return { type: 'FeatureCollection', features: pick(data.features) };
  }
  if (Array.isArray(data.features)) {
    return { type: 'FeatureCollection', features: pick(data.features) };
  }
  if (Array.isArray(data)) {
    return { type: 'FeatureCollection', features: pick(data) };
  }
  return empty;
}

function toPolygonFeature(feature) {
  if (!feature || !feature.geometry) return null;
  const { geometry } = feature;
  if (
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return feature;
  }

  // Buffer non-polygon geometries (e.g., points/lines) to small polygons
  try {
    const buffered = turf.buffer(feature, 0.05, { units: 'kilometers', steps: 16 });
    if (buffered && buffered.geometry && buffered.geometry.coordinates?.length) {
      return {
        type: 'Feature',
        properties: feature.properties || {},
        geometry: buffered.geometry
      };
    }
  } catch (err) {
    // ignore
  }
  return null;
}

function updateProvinceLabel() {
  const label = document.getElementById('province-label');
  if (!label) return;
  label.textContent = selectedProvince === 'all' ? 'ทุกจังหวัด' : selectedProvince;
}
