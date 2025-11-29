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
let distanceWorker = null;
let workerInitialized = false;

const statusConfig = {
  flooded: { label: 'น้ำท่วม', badgeClass: 'badge--danger', color: '#ef4444' },
  high: { label: 'เสี่ยงสูง', badgeClass: 'badge--warning', color: '#f97316' },
  medium: { label: 'เฝ้าระวัง', badgeClass: 'badge--watch', color: '#eab308' },
  low: { label: 'ปลอดภัย', badgeClass: 'badge--safe', color: '#22c55e' },
  nodata: { label: 'ไม่มีข้อมูลน้ำท่วม', badgeClass: 'badge--watch', color: '#94a3b8' }
};

document.addEventListener('DOMContentLoaded', () => {
  setupMap();
  enhanceCustomSelects();
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
      refreshData(true, { showRenderLoading: true });
    });
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
      selectedType = e.target.value || 'all';
      // Reuse computedFacilities if available (much faster - no recalculation)
      if (computedFacilities.length > 0) {
        rerenderFiltered();
      } else {
        void withRenderLoading(async () => await calculateAndRender());
      }
    });
  }
}

function enhanceCustomSelects() {
  ['province-filter', 'type-filter', 'risk-filter'].forEach((id) => enhanceSelect(id));
}

function enhanceSelect(id) {
  const select = document.getElementById(id);
  if (!select || select.dataset.enhanced) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  select.classList.add('custom-select__native');
  select.dataset.enhanced = 'true';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.setAttribute('data-native-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select__trigger';
  wrapper.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'custom-select__menu';
  wrapper.appendChild(menu);

  const closeMenu = () => wrapper.classList.remove('open');
  const openMenu = () => {
    buildMenu();
    wrapper.classList.add('open');
  };

  function buildMenu() {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select__option' + (opt.selected ? ' is-selected' : '');
      item.textContent = opt.textContent;
      item.dataset.value = opt.value;
      item.addEventListener('click', () => {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu();
      });
      menu.appendChild(item);
    });
  }

  function syncTrigger() {
    const opt = select.options[select.selectedIndex];
    trigger.textContent = opt ? opt.textContent : '—';
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrapper.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) closeMenu();
  });

  select.addEventListener('change', syncTrigger);

  syncTrigger();
}

function syncEnhancedSelects() {
  ['province-filter', 'type-filter', 'risk-filter'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select || !select.dataset.enhanced) return;
    const trigger = select.parentElement?.querySelector('.custom-select__trigger');
    if (!trigger) return;
    const opt = select.options[select.selectedIndex];
    trigger.textContent = opt ? opt.textContent : '—';
  });
}

function startAutoRefresh() {
  if (autoRefreshId) clearInterval(autoRefreshId);
  autoRefreshId = setInterval(() => refreshData(false), REFRESH_MS);
}

async function refreshData(manual = false, { showRenderLoading = false } = {}) {
  if (isLoading) return;
  setLoading(true);
  if (showRenderLoading) setRenderLoading(true);
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
    
    // Reinitialize worker with new flood data
    workerInitialized = false;
    await initializeWorker();
    
    await calculateAndRender();
    syncEnhancedSelects();
  } catch (err) {
    console.error('คำนวณผลล้มเหลว', err);
    errorMsg = errorMsg || 'คำนวณผลไม่สำเร็จ';
  } finally {
    setLastUpdated(manual, !!errorMsg);
    showError(errorMsg);
    setLoading(false);
    if (showRenderLoading) setRenderLoading(false);
  }
}

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`โหลดข้อมูลล้มเหลว: ${path}`);
  return res.json();
}

async function loadFloodData() {
  // 1) เรียก backend ภายใน (หลีกเลี่ยง CORS/GISTDA redirect)
  const backendBase = (config.backendBaseUrl || 'https://flood-detection-health-office.onrender.com').replace(/\/$/, '');
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
    // First request to get total count
    const firstQs = new URLSearchParams();
    if (provinceSlug) firstQs.set('province', provinceSlug);
    firstQs.set('limit', String(limit));
    firstQs.set('offset', '0');
    const firstUrl = `${backendBase}/api/flood?${firstQs.toString()}`;
    const firstRes = await fetch(firstUrl, {
      mode: 'cors',
      method: 'GET',
      cache: 'no-store'
    });
    if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status} จาก backend`);
    const firstPayload = await firstRes.json();
    const firstDataset = normalizeFlood(firstPayload?.data || firstPayload);
    aggregated = firstDataset.features || [];
    const total = firstPayload?.total || firstDataset.features?.length || 0;
    
    // If we need more pages, fetch them in parallel batches
    if (total > limit) {
      const remainingPages = Math.ceil((total - limit) / limit);
      const maxPagesToFetch = Math.min(remainingPages, 19); // Max 20 total pages
      const batchSize = 5; // Fetch 5 pages at a time in parallel
      
      for (let batchStart = 1; batchStart <= maxPagesToFetch; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize - 1, maxPagesToFetch);
        const batchPromises = [];
        
        for (let page = batchStart; page <= batchEnd; page += 1) {
          const pageOffset = page * limit;
          const qs = new URLSearchParams();
          if (provinceSlug) qs.set('province', provinceSlug);
          qs.set('limit', String(limit));
          qs.set('offset', String(pageOffset));
          const backendUrl = `${backendBase}/api/flood?${qs.toString()}`;
          
          batchPromises.push(
            fetch(backendUrl, {
              mode: 'cors',
              method: 'GET',
              cache: 'no-store'
            }).then(async (res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status} จาก backend`);
              const payload = await res.json();
              return normalizeFlood(payload?.data || payload);
            })
          );
        }
        
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach((dataset) => {
          aggregated = aggregated.concat(dataset.features || []);
        });
        
        // Early exit if we got all data
        if (aggregated.length >= total) break;
      }
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

/**
 * Handle worker messages
 */
function handleWorkerMessage(event) {
  const { type, results, progress, completed } = event.data;
  
  if (type === 'ready') {
    workerInitialized = true;
    return;
  }
  
  if (type === 'progress' || type === 'results') {
    // Update facilities with calculated distances
    if (results && Array.isArray(results)) {
      results.forEach((result) => {
        const facility = computedFacilities[result.index];
        if (facility) {
          facility.distanceKm = result.distanceKm;
          facility.statusKey = result.statusKey;
          facility._calculated = true;
        }
      });
      
      // Update UI with new results
      const filtered = computedFacilities.filter(filterFacilities);
      renderMarkers(filtered);
      renderTable(filtered);
    }
    
    if (completed) {
      console.log('Distance calculations completed');
    }
    return;
  }
  
  if (type === 'complete') {
    console.log('All distance calculations completed');
    return;
  }
}

/**
 * Initialize or get the distance worker
 */
function getDistanceWorker() {
  if (!distanceWorker && typeof Worker !== 'undefined') {
    try {
      distanceWorker = new Worker('./distance-worker.js');
      
      // Handle worker messages (set once)
      distanceWorker.onmessage = handleWorkerMessage;
      
      distanceWorker.onerror = (error) => {
        console.error('Worker error:', error);
        // Fallback to main thread if worker fails
        distanceWorker = null;
        workerInitialized = false;
      };
    } catch (error) {
      console.warn('Failed to create worker, falling back to main thread:', error);
      distanceWorker = null;
      workerInitialized = false;
    }
  }
  return distanceWorker;
}

/**
 * Initialize worker with flood data
 * Returns a promise that resolves when worker is ready
 */
function initializeWorker() {
  return new Promise((resolve) => {
    const worker = getDistanceWorker();
    if (!worker || !floodGeojson) {
      resolve(false);
      return;
    }
    
    if (workerInitialized) {
      resolve(true);
      return;
    }
    
    // Set up one-time ready handler
    let readyResolved = false;
    const checkReady = (event) => {
      if (event.data.type === 'ready' && !readyResolved) {
        readyResolved = true;
        workerInitialized = true;
        resolve(true);
      }
    };
    
    // Add temporary listener for ready message
    worker.addEventListener('message', checkReady);
    
    worker.postMessage({
      type: 'init',
      payload: {
        floodFeatures: floodGeojson.features || []
      }
    });
    
    // Timeout after 2 seconds
    setTimeout(() => {
      worker.removeEventListener('message', checkReady);
      if (!readyResolved) {
        readyResolved = true;
        console.warn('Worker initialization timeout');
        resolve(false);
      }
    }, 2000);
  });
}

async function calculateAndRender() {
  if (!floodGeojson) {
    floodGeojson = { type: 'FeatureCollection', features: [] };
  }
  MAX_RENDER_FACILITIES = 2000

  const hasFlood = Array.isArray(floodGeojson.features) && floodGeojson.features.length > 0;

  // Filter by province only (ignore type filter) so we can reuse computedFacilities when switching types
  const selectedProv = normalizeProvince(selectedProvince);
  const provinceFilteredFacilities = facilities
    .filter((facility) => {
      const facilityProv = normalizeProvince(facility.province);
      return selectedProv === 'all' || !selectedProv || facilityProv === selectedProv;
    })
    .filter(hasValidCoords)
    .slice(0, MAX_RENDER_FACILITIES);

  // Initialize with placeholder data (no distances calculated yet)
  const enriched = provinceFilteredFacilities.map((facility) => ({
    ...facility,
    distanceKm: Number.POSITIVE_INFINITY,
    statusKey: hasFlood ? 'nodata' : 'nodata',
    _calculated: false
  }));

  // Store all facilities for the province (so type switching can reuse them)
  computedFacilities = enriched;

  // Render immediately with placeholder data
  const filtered = enriched.filter(filterFacilities);
  renderFloodLayer();
  renderMarkers(filtered);
  renderTable(filtered);

  // Try to use Web Worker for calculations
  const worker = getDistanceWorker();
  
  if (worker && typeof Worker !== 'undefined') {
    // Use Web Worker for non-blocking calculations
    const workerReady = await initializeWorker();
    
    if (workerReady) {
      // Send calculation request to worker
      worker.postMessage({
        type: 'calculateAll',
        payload: {
          facilities: enriched,
          hasFlood
        }
      });
    } else {
      // Fallback to main thread if worker initialization failed
      console.warn('Worker initialization failed, using main thread');
      // Fall through to main thread calculation below
    }
  }
  
  // Fallback to main thread if Web Workers not available or failed
  if (!worker || typeof Worker === 'undefined' || !workerInitialized) {
    // Fallback to main thread if Web Workers not available
    console.warn('Web Workers not available, using main thread (may freeze UI)');
    const CHUNK_SIZE = 20; // Smaller chunks for fallback
    let currentIndex = 0;

    const calculateChunk = (deadline) => {
      let processed = 0;

      while (currentIndex < enriched.length && (deadline.timeRemaining() > 0 || deadline.didTimeout)) {
        if (processed >= CHUNK_SIZE) break;
        
        const facility = enriched[currentIndex];
        if (!facility._calculated) {
          const point = turf.point([facility.lng, facility.lat]);
          const { distanceKm, inside } = hasFlood
            ? findNearestFloodDistance(point, floodGeojson.features)
            : { distanceKm: Number.POSITIVE_INFINITY, inside: false };
          facility.distanceKm = distanceKm;
          facility.statusKey = classifyRisk(distanceKm, inside, hasFlood);
          facility._calculated = true;
          processed++;
        }
        currentIndex++;
      }

      // Update UI with newly calculated data
      if (processed > 0) {
        const filtered = enriched.filter(filterFacilities);
        renderMarkers(filtered);
        renderTable(filtered);
      }

      // Continue if there's more work
      if (currentIndex < enriched.length) {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(calculateChunk, { timeout: 100 });
        } else {
          setTimeout(calculateChunk, 0);
        }
      }
    };

    // Start progressive calculation
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(calculateChunk, { timeout: 100 });
    } else {
      // Fallback for browsers without requestIdleCallback
      const fallbackCalculate = async () => {
        for (let i = 0; i < enriched.length; i += CHUNK_SIZE) {
          const chunk = enriched.slice(i, i + CHUNK_SIZE);
          chunk.forEach((facility) => {
            if (!facility._calculated) {
              const point = turf.point([facility.lng, facility.lat]);
              const { distanceKm, inside } = hasFlood
                ? findNearestFloodDistance(point, floodGeojson.features)
                : { distanceKm: Number.POSITIVE_INFINITY, inside: false };
              facility.distanceKm = distanceKm;
              facility.statusKey = classifyRisk(distanceKm, inside, hasFlood);
              facility._calculated = true;
            }
          });
          
          // Update UI
          const filtered = enriched.filter(filterFacilities);
          renderMarkers(filtered);
          renderTable(filtered);
          
          // Yield to event loop
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      };
      fallbackCalculate();
    }
  }
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

function hasValidCoords(facility) {
  return Number.isFinite(facility?.lat) && Number.isFinite(facility?.lng);
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

  const [lng, lat] = point.geometry.coordinates;
  let shortest = Number.POSITIVE_INFINITY;
  let inside = false;
  let foundInside = false;
  
  // Thresholds for risk classification (we only need to know which threshold we're in)
  const HIGH_RISK_THRESHOLD = 3; // < 3km = high risk
  const MEDIUM_RISK_THRESHOLD = 10; // 3-10km = medium risk
  const LOW_RISK_THRESHOLD = 50; // > 50km = safe (don't need exact distance)

  // Pre-compute bounding boxes for fast approximate distance checks
  const featuresWithBbox = validFeatures.map((f, idx) => {
    try {
      const bbox = turf.bbox(f);
      // Calculate approximate distance to bbox center (much faster than exact)
      const centerX = (bbox[0] + bbox[2]) / 2;
      const centerY = (bbox[1] + bbox[3]) / 2;
      const approxDist = Math.sqrt(Math.pow(lng - centerX, 2) + Math.pow(lat - centerY, 2)) * 111; // Rough km conversion
      return { feature: f, bbox, approxDist, idx };
    } catch {
      return { feature: f, bbox: null, approxDist: Infinity, idx };
    }
  });

  // Sort by approximate distance (check closer features first)
  featuresWithBbox.sort((a, b) => a.approxDist - b.approxDist);

  // Only check features within reasonable distance (50km threshold + buffer)
  const nearbyFeatures = featuresWithBbox.filter(f => f.approxDist <= LOW_RISK_THRESHOLD + 10);
  
  // Create a map for quick lookup
  const featureBboxMap = new Map();
  nearbyFeatures.forEach(f => featureBboxMap.set(f.feature, f));

  turf.flattenEach({ type: 'FeatureCollection', features: nearbyFeatures.map(f => f.feature) }, (feature) => {
    try {
      // Check if inside first (most important - if inside, we're done!)
      if (!foundInside && turf.booleanPointInPolygon(point, feature)) {
        inside = true;
        shortest = 0;
        foundInside = true;
        return;
      }
      
      // Only calculate exact distance if we need to (within risk thresholds)
      if (!foundInside && shortest > HIGH_RISK_THRESHOLD) {
        const withBbox = featureBboxMap.get(feature);
        
        // If approximate distance is > 50km, skip expensive exact calculation
        if (withBbox && withBbox.approxDist > LOW_RISK_THRESHOLD) {
          if (shortest > LOW_RISK_THRESHOLD) {
            shortest = LOW_RISK_THRESHOLD + 1; // Mark as "safe" (>50km)
          }
          return;
        }
        
        // Only calculate exact distance for features that might be in risk zones
        if (shortest > HIGH_RISK_THRESHOLD) {
          const boundaryLine = turf.polygonToLine(feature);
          const distance = turf.pointToLineDistance(point, boundaryLine, { units: 'kilometers' });
          if (Number.isFinite(distance) && distance < shortest) {
            shortest = distance;
            // Early exit if we found it's inside or very close
            if (shortest < 0.01) foundInside = true;
            // If we found it's > 50km, mark as safe threshold
            if (shortest > LOW_RISK_THRESHOLD) {
              shortest = LOW_RISK_THRESHOLD + 1; // Mark as safe (>50km)
            }
          }
        }
      }
    } catch (err) {
      // Skip invalid features silently
    }
  });

  // If no nearby features found, mark as safe (>50km)
  if (nearbyFeatures.length === 0) {
    shortest = LOW_RISK_THRESHOLD + 1;
  }

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
  if (distanceKm < 3) return `${distanceKm.toFixed(2)} กม.`; // Show exact for high risk
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} กม.`; // Show 1 decimal for medium risk
  if (distanceKm <= 50) return `${Math.round(distanceKm)} กม.`; // Round for low risk
  return '> 50 กม.'; // Threshold for safe facilities
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

function waitForPaint() {
  // Double rAF to ensure the overlay paints before heavy sync work
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function withRenderLoading(fn) {
  setRenderLoading(true);
  try {
    await waitForPaint();
    await fn();
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
    provinceSelect.innerHTML = provinces.map((p) => `<option value="${p}">${provinceNameMap[p] || p}</option>`).join('');
    if (!selectedProvince || (!provinces.includes(selectedProvince) && selectedProvince !== 'all')) {
      selectedProvince = provinces.includes('สงขลา') ? 'สงขลา' : provinces[0] || 'all';
    }
    provinceSelect.value = selectedProvince;
    updateProvinceLabel();
  }
  if (typeSelect) {
    const types = Array.from(new Set(facilityData.map((f) => f.type).filter(Boolean))).sort();
    typeSelect.innerHTML = types.map((t) => `<option value="${t}">${t}</option>`).join('');
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
