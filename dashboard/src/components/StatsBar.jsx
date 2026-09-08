import "./StatsBar.css"

// One card per status in the Job enum. `failed` and `dead` are different things:
// `failed` is permanent — a blocked URL or an unknown job type, refused on the
// first attempt. `dead` means three attempts were spent. Leaving `failed` out
// meant those jobs showed in the table and in no counter.
const CARDS = [
  { status: "pending",   label: "Pending",   color: "var(--pending)" },
  { status: "claimed",   label: "Claimed",   color: "var(--claimed)" },
  { status: "completed", label: "Completed", color: "var(--completed)" },
  { status: "failed",    label: "Failed",    color: "var(--failed)" },
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
