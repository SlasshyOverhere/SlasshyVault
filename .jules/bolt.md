## 2026-06-29 - [Avoid O(N^2) max loops in React maps]
**Learning:** Found an O(N^2) pattern in `src/components/AnalyticsView.tsx` where `Math.max(...array.map())` was recalculating inside a `array.map()` loop for rendering.
**Action:** Lift the max calculation outside the loop using an IIFE (Immediately Invoked Function Expression) pattern inside the JSX to cache the max value, improving runtime from O(N^2) to O(N).
