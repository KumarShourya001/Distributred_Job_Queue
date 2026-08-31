import "./StatsBar.css"

// `failed` is in the Job enum but the worker never writes it — a failure goes
// straight back to pending or on to dead. A permanently-zero counter would be
// noise, so it isn't here.
const CARDS = [
  { status: "pending",   label: "Pending",   color: "var(--pending)" },
  { status: "claimed",   label: "Claimed",   color: "var(--claimed)" },
  { status: "completed", label: "Completed", color: "var(--completed)" },
  { status: "dead",      label: "Dead",      color: "var(--dead)" },
]

// The counters double as the filter control — clicking one narrows the table,
// clicking it again clears. Cheaper than a separate filter bar, and it makes
// the numbers useful rather than decorative.
export default function StatsBar({ jobs, filter, onFilter }) {
  return (
    <section className="stats" role="group" aria-label="Filter jobs by status">
      {CARDS.map(({ status, label, color }) => {
        const active = filter === status
        const n = jobs.filter((j) => j.status === status).length

        return (
          <button
            key={status}
            type="button"
            className="stat"
            style={{ "--stat-color": color }}
            data-active={active || undefined}
            aria-pressed={active}
            onClick={() => onFilter(active ? null : status)}
          >
            <span className="label">{label}</span>
            <span className="value">{n}</span>
          </button>
        )
      })}
    </section>
  )
}
