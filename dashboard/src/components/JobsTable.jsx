import { STATUS } from "../lib/config"
import { resultText, isError, timeAgo } from "../lib/format"
import "./JobsTable.css"

export default function JobsTable({ jobs, loading, now }) {
  return (
    <section className="panel">
      <header>
        <h2>Jobs</h2>
        <span className="meta">{jobs.length ? `${jobs.length} most recent` : ""}</span>
      </header>

      {loading ? (
        <div className="empty">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">
          <strong>No jobs yet</strong>
          Submit one on the left and it will appear here the moment it&apos;s queued.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <colgroup>
              <col className="c-id" />
              <col className="c-type" />
              <col className="c-status" />
              <col className="c-attempts" />
              <col className="c-result" />
              <col className="c-age" />
            </colgroup>
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Result</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const meta = STATUS[job.status] || STATUS.pending
                const text = resultText(job)
                const failed = isError(job)

                return (
                  <tr key={job._id}>
                    <td className="id">{job._id.slice(-6)}</td>
                    <td className="type">{job.type}</td>
                    <td>
                      <span
                        className="pill"
                        style={{ "--pill-fg": meta.fg, "--pill-bg": meta.bg }}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="num">{job.attempts}</td>
                    {/* title= gives the full text on hover when it's truncated */}
                    <td className={failed ? "result err" : "result"} title={text || ""}>
                      {text || <span className="none">—</span>}
                    </td>
                    <td className="age">{timeAgo(job.createdAt, now)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
