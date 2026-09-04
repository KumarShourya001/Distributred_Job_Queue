import { useState } from "react"
import { API_URL, JOB_TYPES } from "../lib/config"
import "./SubmitForm.css"

// All state here is local to the form — nothing outside needs to know what's
// typed in the textarea. The submitted job reaches the table over the
// WebSocket, so this component never touches the shared job state.
export default function SubmitForm({ onSessionLost }) {
  const [type, setType] = useState(JOB_TYPES[0])
  const [payloadText, setPayloadText] = useState(`{
  "url": "https://webhook.site/YOUR-UNIQUE-ID",
  "body": { "hello": "from my job queue" }
}`)
  const [error, setError] = useState(null)
  const [ok, setOk] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setOk(false)

    let payload
    try {
      payload = JSON.parse(payloadText)
    } catch (err) {
      setError(`Payload isn't valid JSON — ${err.message}`)
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`${API_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, payload }),
        credentials: "include",
      })

      // An expired session is not a form error — showing "Unauthorized" next to
      // the button leaves someone retyping a payload that can never be accepted.
      if (res.status === 401) {
        onSessionLost()
        return
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || data.message || `Request failed (HTTP ${res.status})`)
        return
      }

      setError(null)
      setOk(true)
    } catch (err) {
      setError(`Could not reach the API — ${err.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="panel">
      <header><h2>Submit a job</h2></header>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="job-type">Type</label>
          <select id="job-type" value={type} onChange={(e) => setType(e.target.value)}>
            {JOB_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="hint">Each type maps to a handler function on the worker.</span>
        </div>

        <div className="field">
          <label htmlFor="job-payload">Payload (JSON)</label>
          <textarea
            id="job-payload"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={7}
            spellCheck={false}
          />
          <span className="hint">
            <code>url</code> is where the worker sends the request, <code>body</code> is what it sends.
          </span>
        </div>

        <button className="submit" type="submit" disabled={submitting}>
          {submitting ? "Queueing…" : "Submit job"}
        </button>

        {error && <p className="msg" data-tone="error" role="alert">{error}</p>}
        {ok && !error && (
          <p className="msg" data-tone="ok" role="status">
            Queued. It should appear in the table within a second.
          </p>
        )}
      </form>
    </section>
  )
}
