## 2024-06-29 — Avoid O(N log N) sorts for binary partitions
**Learning:** `sortPinnedFirst` used `.toSorted()` with `pinned.has()` checking inside the comparator, causing unnecessary O(N log N) overhead and repeated string type coercions during sorting.
**Action:** When ordering arrays based on a binary boolean condition (like pinned vs unpinned), avoid `toSorted()`. Use a single O(N) iteration to push items into two separate arrays and concatenate them.
