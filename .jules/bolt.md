## 2025-05-18 - Avoid repeated array calculations inside React mapping loops
**Learning:** In complex mapping loops within React, doing operations that calculate data across an entire array on every iteration (e.g., finding the `Math.max` for a progress bar ratio using `Math.max(...data.map(d => d.value))`) escalates the rendering complexity to O(N²), causing serious slowdowns when the array scales up in components like `AnalyticsView.tsx`.
**Action:** Use an Immediately Invoked Function Expression (IIFE) around the block, or pre-calculate variables utilizing `useMemo` before mapping. This allows computing single values once before entering the loop to ensure strict O(N) array mapping performance.
## 2025-05-19 - Pre-computing Track Preference Matching
**Learning:** Calling `.split(",")` and `Array.prototype.includes` repeatedly inside an array iteration (like `cachedTracks.find()`) results in O(N*M) lookups, causing unnecessary work.
**Action:** When matching items based on delimited string preferences, parse the preference string outside the lookup loop and store the results in a `Set` for O(1) matching.
