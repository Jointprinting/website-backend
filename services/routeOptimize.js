// services/routeOptimize.js
//
// Stop-order optimization for Today's Run: nearest-neighbor seed + 2-opt
// improvement over straight-line (haversine) distance. Straight-line is the
// right cost model here — we're ordering dispensary stops for a driving day,
// and road distance correlates tightly at town scale; no external API, no
// waypoint caps, deterministic. Open path (start fixed at the owner's
// location, no return leg).

function haversineMi(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  // Clamp: float rounding can push h a hair past 1 (near-antipodal points),
  // and asin(√h>1) is NaN — which would poison a whole route's mileage.
  return 2 * 3958.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function pathMiles(start, stops) {
  let total = 0, prev = start;
  for (const s of stops) { total += haversineMi(prev, s); prev = s; }
  return total;
}

/**
 * Order `stops` ([{lat,lng,...}]) starting from `start` ({lat,lng}).
 * Returns { order: number[] (indexes into the input), miles } — the caller
 * keeps its own objects and just applies the permutation.
 */
function optimizeStopOrder(start, stops) {
  const n = stops.length;
  if (n <= 1) return { order: stops.map((_, i) => i), miles: pathMiles(start, stops) };

  // Nearest-neighbor seed
  const remaining = new Set(stops.map((_, i) => i));
  const order = [];
  let cur = start;
  while (remaining.size) {
    let best = -1, bestD = Infinity;
    for (const i of remaining) {
      const d = haversineMi(cur, stops[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    order.push(best);
    remaining.delete(best);
    cur = stops[best];
  }

  // 2-opt: reverse segments while it shortens the path. n is small (a day's
  // run), so the O(n²) sweep is nothing.
  const dist = (i, j) => haversineMi(i < 0 ? start : stops[order[i]], stops[order[j]]);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = -1; i < n - 2; i++) {
      for (let j = i + 2; j < n; j++) {
        // current edges: (i → i+1) and (j → j+1 if exists)
        const before = dist(i, i + 1) + (j + 1 < n ? dist(j, j + 1) : 0);
        const after = dist(i, j) + (j + 1 < n ? haversineMi(stops[order[i + 1]], stops[order[j + 1]]) : 0);
        if (after + 1e-9 < before) {
          // reverse order[i+1..j]
          let a = i + 1, b = j;
          while (a < b) { const t = order[a]; order[a] = order[b]; order[b] = t; a++; b--; }
          improved = true;
        }
      }
    }
  }

  return { order, miles: pathMiles(start, order.map((i) => stops[i])) };
}

module.exports = { optimizeStopOrder, haversineMi, pathMiles };
