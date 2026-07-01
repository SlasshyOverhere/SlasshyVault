## 2025-05-18 - Avoid repeated array calculations inside React mapping loops
**Learning:** In complex mapping loops within React, doing operations that calculate data across an entire array on every iteration (e.g., finding the `Math.max` for a progress bar ratio using `Math.max(...data.map(d => d.value))`) escalates the rendering complexity to O(N²), causing serious slowdowns when the array scales up in components like `AnalyticsView.tsx`.
**Action:** Use an Immediately Invoked Function Expression (IIFE) around the block, or pre-calculate variables utilizing `useMemo` before mapping. This allows computing single values once before entering the loop to ensure strict O(N) array mapping performance.

## 2025-06-25 - Avoid redundant string operations and allocations in loop conditions
**Learning:** In array operations like `.find()` or `.filter()`, re-parsing strings (e.g. `storedPreference.split(',').map(x => x.trim())`) inside the callback allocates new arrays and performs redundant processing on every iteration, leading to $O(N)$ string allocations inside an outer loop.
**Action:** Extract string processing and allocations outside loop iterations. For collections of values meant for membership testing (`includes`), compute a `Set` outside the loop and use `Set.has()` to shift lookup from $O(M \times N)$ to $O(M + N)$.
