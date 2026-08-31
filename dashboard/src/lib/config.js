// Vite inlines these at BUILD time, not runtime. Changing them on a host
// requires a rebuild, not just a restart. Only VITE_-prefixed vars are exposed
// to browser code, and everything exposed is public — never put a secret here.
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"
export const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000"

// Mirrors the keys of the worker's handler registry. The API builds its Zod
// enum from that same registry, so a type missing here is one the API rejects.
export const JOB_TYPES = ["http_request"]

// Semantic colours for job state, kept separate from the interactive accent
// so "blue" never reads as a status.
export const STATUS = {
  pending:   { fg: "var(--pending)",   bg: "var(--pending-bg)" },
  claimed:   { fg: "var(--claimed)",   bg: "var(--claimed-bg)" },
  completed: { fg: "var(--completed)", bg: "var(--completed-bg)" },
  failed:    { fg: "var(--failed)",    bg: "var(--failed-bg)" },
  dead:      { fg: "var(--dead)",      bg: "var(--dead-bg)" },
}
