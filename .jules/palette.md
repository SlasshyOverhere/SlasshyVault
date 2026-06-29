
## 2026-06-29 — Accessible Custom Dropdown Menu Pattern
Learning: Custom dropdown menus often lack screen reader and keyboard accessibility natively. Trigger buttons need context and items need roles.
Action: Add `aria-label`, `aria-expanded`, and `aria-haspopup="menu"` to dropdown trigger buttons. Add `role="menu"` to the dropdown container and `role="menuitem"` to interactive child elements. Always implement visible keyboard focus outlines (`focus-visible`). Hide decorative icons with `aria-hidden="true"`.
