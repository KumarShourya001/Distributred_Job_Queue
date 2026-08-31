import "./Masthead.css"

export default function Masthead({ connected }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div>
          <h1>Distributed Job Queue</h1>
          <p className="tagline">
            Submit a job and watch it move through the system in real time —
            claimed by a worker, executed, retried on failure, and dead-lettered
            when it gives up.
          </p>
        </div>

        <span className="conn" data-state={connected ? "live" : "down"} role="status">
          <span className="dot" />
          {connected ? "Live" : "Reconnecting"}
        </span>
      </div>
    </header>
  )
}
