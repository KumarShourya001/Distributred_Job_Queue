import "./StatsBar.css"

// `failed` is in the Job enum but the worker never writes it — a failure goes
// straight back to pending or on to dead. Showing a permanently-zero counter
// would be noise, so it isn't here.
const CARDS = [
  { status: "pending",   label: "Pending",   color: "var(--pending)" },
  { status: "claimed",   label: "Claimed",   color: "var(--claimed)" },
  { status: "completed", label: "Completed", color: "var(--completed)" },
  { status: "dead",      label: "Dead",      color: "var(--dead)" },
]

export default function StatsBar({ jobs }) {
  return (
    <section className="stats">
      {CARDS.map(({ status, label, color }) => (
        <div key={status} className="stat" style={{ "--stat-color": color }}>
          <span className="label">{label}</span>
          <span className="value">
            {jobs.filter((j) => j.status === status).length}
          </span>
        </div>
      ))}
    </section>
  )
}
