/**
 * Shared cuisine options for the fusion cuisine dropdown.
 * Centralized here so UI and logic use the exact same values.
 */
// Shared cuisine list used by the fusion-cuisine dropdown.
// Keeping it in one file makes future updates simple and consistent.
export const CUISINE_OPTIONS = [
  "Japanese",
  "Italian",
  "Mexican",
  "Thai",
  "Middle Eastern",
  "Korean",
  "Chinese",
  "French",
  "Greek",
  "Peruvian",
] as const;
