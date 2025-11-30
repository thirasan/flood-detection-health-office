// Web Worker for calculating flood distances
// This runs in a background thread, keeping the UI responsive

// Load Turf.js library in the worker
importScripts('https://unpkg.com/@turf/turf@6.5.0/turf.min.js');

// Constants
const HIGH_RISK_THRESHOLD = 3; // < 3km = high risk
const MEDIUM_RISK_THRESHOLD = 10; // 3-10km = medium risk
const LOW_RISK_THRESHOLD = 50; // > 50km = safe
const CHUNK_SIZE = 20; // Process 20 facilities at a time

// Cache for pre-computed bboxes (computed once per flood dataset)
let floodBboxCache = null;
let floodFeaturesCache = null;

/**
 * Pre-compute bounding boxes for all flood features (done once)
 */
function buildFloodBboxCache(floodFeatures) {
  const validFeatures = floodFeatures.filter(
    (f) =>
      f &&
      f.geometry &&
      Array.isArray(f.geometry.coordinates) &&
      f.geometry.coordinates.length > 0
  );

  return validFeatures.map((f, idx) => {
    try {
      const bbox = turf.bbox(f);
      return { feature: f, bbox, idx };
    } catch {
      return { feature: f, bbox: null, idx };
    }
  });
}

/**
 * Find nearest flood distance for a single facility
 */
function findNearestFloodDistance(point, floodFeaturesWithBbox) {
  if (!floodFeaturesWithBbox || floodFeaturesWithBbox.length === 0) {
    return { distanceKm: Number.POSITIVE_INFINITY, inside: false };
  }

  const [lng, lat] = point.geometry.coordinates;
  let shortest = Number.POSITIVE_INFINITY;
  let inside = false;
  let foundInside = false;

  // Calculate approximate distances to bbox centers
  const featuresWithDist = floodFeaturesWithBbox.map((f) => {
    if (!f.bbox) {
      return { ...f, approxDist: Infinity };
    }
    const centerX = (f.bbox[0] + f.bbox[2]) / 2;
    const centerY = (f.bbox[1] + f.bbox[3]) / 2;
    const approxDist = Math.sqrt(Math.pow(lng - centerX, 2) + Math.pow(lat - centerY, 2)) * 111;
    return { ...f, approxDist };
  });

  // Sort by approximate distance (check closer features first)
  featuresWithDist.sort((a, b) => a.approxDist - b.approxDist);

  // Only check features within reasonable distance
  const nearbyFeatures = featuresWithDist.filter(
    (f) => f.approxDist <= LOW_RISK_THRESHOLD + 10
  );

  // Create a map for quick lookup
  const featureBboxMap = new Map();
  nearbyFeatures.forEach((f) => featureBboxMap.set(f.feature, f));

  // Check each nearby feature
  turf.flattenEach(
    { type: 'FeatureCollection', features: nearbyFeatures.map((f) => f.feature) },
    (feature) => {
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
            const distance = turf.pointToLineDistance(point, boundaryLine, {
              units: 'kilometers'
            });
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
    }
  );

  // If no nearby features found, mark as safe (>50km)
  if (nearbyFeatures.length === 0) {
    shortest = LOW_RISK_THRESHOLD + 1;
  }

  if (!Number.isFinite(shortest)) {
    shortest = Number.POSITIVE_INFINITY;
  }

  return { distanceKm: shortest, inside };
}

/**
 * Classify risk based on distance
 */
function classifyRisk(distanceKm, inside, hasFlood = true) {
  if (!hasFlood) return 'nodata';
  if (inside || distanceKm === 0) return 'flooded';
  if (!Number.isFinite(distanceKm)) return 'low';
  if (distanceKm < 3) return 'high';
  if (distanceKm < 10) return 'medium';
  return 'low';
}

/**
 * Process a chunk of facilities
 */
function processChunk(facilities, floodFeaturesWithBbox, hasFlood, startIndex) {
  const results = [];
  const endIndex = Math.min(startIndex + CHUNK_SIZE, facilities.length);

  for (let i = startIndex; i < endIndex; i++) {
    const facility = facilities[i];
    const point = turf.point([facility.lng, facility.lat]);
    const { distanceKm, inside } = hasFlood
      ? findNearestFloodDistance(point, floodFeaturesWithBbox)
      : { distanceKm: Number.POSITIVE_INFINITY, inside: false };

    results.push({
      index: i,
      facilityId: facility.id,
      distanceKm,
      statusKey: classifyRisk(distanceKm, inside, hasFlood)
    });
  }

  return results;
}

/**
 * Main message handler
 */
self.onmessage = function (event) {
  const { type, payload } = event.data;

  if (type === 'init') {
    // Initialize with flood data (build cache once)
    const { floodFeatures } = payload;
    floodFeaturesCache = floodFeatures;
    floodBboxCache = buildFloodBboxCache(floodFeatures);
    self.postMessage({ type: 'ready' });
    return;
  }

  if (type === 'calculate') {
    // Calculate distances for facilities
    const { facilities, hasFlood, startIndex } = payload;

    if (!floodBboxCache) {
      // Fallback: build cache if not initialized
      floodBboxCache = buildFloodBboxCache(floodFeaturesCache || []);
    }

    const results = processChunk(facilities, floodBboxCache, hasFlood, startIndex || 0);

    // Send results back
    self.postMessage({
      type: 'results',
      results,
      completed: (startIndex || 0) + results.length >= facilities.length
    });
    return;
  }

  if (type === 'calculateAll') {
    // Calculate all facilities in chunks, sending progressive updates
    const { facilities, hasFlood } = payload;

    if (!floodBboxCache && floodFeaturesCache) {
      floodBboxCache = buildFloodBboxCache(floodFeaturesCache);
    }

    let currentIndex = 0;
    const total = facilities.length;

    // Process in chunks and send results progressively
    const processNextChunk = () => {
      if (currentIndex >= total) {
        self.postMessage({ type: 'complete' });
        return;
      }

      const results = processChunk(facilities, floodBboxCache, hasFlood, currentIndex);
      currentIndex += results.length;

      self.postMessage({
        type: 'progress',
        results,
        progress: currentIndex / total,
        completed: currentIndex >= total
      });

      // Process next chunk (use setTimeout to yield to event loop)
      setTimeout(processNextChunk, 0);
    };

    processNextChunk();
  }
};

