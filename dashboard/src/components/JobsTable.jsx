import { useState } from "react"
import { STATUS } from "../lib/config"
import { resultText, isError, timeAgo } from "../lib/format"
import "./JobsTable.css"

export default function JobsTable({ jobs, total, filter, onClearFilter, loading, now }) {
  // Which row is expanded is view state and nothing outside cares, so it lives
  // here rather than in App.
  const [openId, setOpenId] = useState(null)

  const meta = filter
    ? `${jobs.length} ${filter} of ${total}`
    : total
      ? `${total} most recent`
      : ""

  return (
    <section className="panel">
      <header>
        <h2>Jobs</h2>
        <span className="meta">{meta}</span>
      </header>

      {loading ? (
        <div className="empty">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">
          {filter ? (
            <>
              <strong>No {filter} jobs</strong>
              None of the {total} loaded jobs have this status.{" "}
              <button type="button" className="linkish" onClick={onClearFilter}>
                Show all
              </button>
            </>
          ) : (
            <>
              <strong>No jobs yet</strong>
              Submit one on the left and it will appear here the moment it&apos;s queued.
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <colgroup>
              <col className="c-open" />
              <col className="c-id" />
              <col className="c-type" />
              <col className="c-status" />
              <col className="c-attempts" />
              <col className="c-result" />
              <col className="c-age" />
            </colgroup>
            <thead>
              <tr>
                <th><span className="sr-only">Expand</span></th>
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
                const s = STATUS[job.status] || STATUS.pending
                const text = resultText(job)
                const failed = isError(job)
                const open = openId === job._id

                return [
                  <tr key={job._id} data-open={open || undefined}>
                    <td className="open">
                      <button
                        type="button"
                        className="chev"
                        aria-expanded={open}
                        aria-label={open ? "Hide job detail" : "Show job detail"}
                        onClick={() => setOpenId(open ? null : job._id)}
                      >
                        <span data-open={open || undefined}>›</span>
                      </button>
                    </td>
                    <td className="id">{job._id.slice(-6)}</td>
                    <td className="type">{job.type}</td>
                    <td>
                      <span className="pill" style={{ "--pill-fg": s.fg }}>
                        {job.status}
                      </span>
                    </td>
                    <td className="num">{job.attempts}</td>
                    {/* title= surfaces the full text when the cell truncates */}
                    <td className={failed ? "result err" : "result"} title={text || ""}>
                      {text || <span className="none">—</span>}
                    </td>
                    <td className="age">{timeAgo(job.createdAt, now)}</td>
                  </tr>,

                  open && (
                    <tr key={`${job._id}-detail`} className="detail-row">
                      <td colSpan={7}>
                        <div className="detail">
                          <div>
                            <h4>Payload sent</h4>
                            <pre>{JSON.stringify(job.payload, null, 2)}</pre>
                          </div>
                          <div>
                            <h4>Result</h4>
                            <pre className={failed ? "err" : undefined}>
                              {job.result
                                ? JSON.stringify(job.result, null, 2)
                                : "null — not finished yet"}
                            </pre>
                          </div>
                          <dl className="facts">
                            <div><dt>Full ID</dt><dd>{job._id}</dd></div>
                            <div><dt>Created</dt><dd>{new Date(job.createdAt).toLocaleString()}</dd></div>
                            <div><dt>Updated</dt><dd>{new Date(job.updatedAt).toLocaleString()}</dd></div>
                          </dl>
                        </div>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
