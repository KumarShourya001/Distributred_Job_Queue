import "./Masthead.css"

export default function Masthead({ connected, onLogout }) {
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

        <div className="masthead-actions">
          <span className="conn" data-state={connected ? "live" : "down"} role="status">
            <span className="dot" />
            {connected ? "Live" : "Reconnecting"}
          </span>

          {onLogout && (
            <button type="button" className="signout" onClick={onLogout}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
