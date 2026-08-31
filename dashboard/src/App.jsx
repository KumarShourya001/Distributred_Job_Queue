import { useEffect, useState } from "react"
import { API_URL, WS_URL } from "./lib/config"
import Masthead from "./components/Masthead"
import About from "./components/About"
import StatsBar from "./components/StatsBar"
import SubmitForm from "./components/SubmitForm"
import JobsTable from "./components/JobsTable"
import "./App.css"

// App owns only the state that more than one section needs: the jobs
// themselves and the connection status. Form state lives inside SubmitForm.
export default function App() {
  const [jobs, setJobs] = useState({})
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [filter, setFilter] = useState(null)   // null = show everything

  async function load() {
    try {
      const res = await fetch(`${API_URL}/jobs?limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const list = await res.json()

      const fetched = Object.fromEntries(list.map((j) => [j._id, j]))
      // `fetched` spread LAST so the server wins: on a reconnect, what we held
      // while disconnected may be minutes stale.
      setJobs((prev) => ({ ...prev, ...fetched }))
      setLoadError(null)
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // 1. Load what already exists, once, on mount.
  useEffect(() => {
    load()
  }, [])

  // 2. Stay current from here on, reconnecting if the socket drops.
  useEffect(() => {
    let cancelled = false
    let socket = null
    let timer = null
    let attempt = 0

    function connect() {
      socket = new WebSocket(WS_URL)

      socket.onopen = () => {
        attempt = 0 // a good connection resets the backoff
        setConnected(true)
        load() // we may have missed change events while disconnected
      }

      socket.onclose = () => {
        setConnected(false)
        if (cancelled) return
        // Back off: 1s, 2s, 4s, 8s... capped at 30s. A fixed 2s retry would
        // hammer a server that's down for an hour with 1,800 attempts, and
        // every dashboard would reconnect in lockstep the moment it returned.
        const delay = Math.min(1000 * 2 ** attempt, 30000)
        attempt += 1
        timer = setTimeout(connect, delay)
      }

      socket.onerror = (err) => console.error("ws error", err)

      socket.onmessage = (msg) => {
        const data = JSON.parse(msg.data)
        if (!data.job) return
        setJobs((prev) => ({ ...prev, [data.job._id]: data.job }))
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(timer)
      if (socket) socket.close()
    }
  }, [])

  // Keeps the Age column honest without re-rendering every second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(id)
  }, [])

  const jobList = Object.values(jobs).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  )

  // Filtering is done over what's already loaded rather than refetching with
  // ?status=. The panel header says "100 most recent", so this is honest, it's
  // instant, and it avoids the question of what a live update should do when
  // a job changes into or out of the active filter.
  const visible = filter ? jobList.filter((j) => j.status === filter) : jobList

  return (
    <>
      <Masthead connected={connected} />
      <div className="shell">
        <About />

      {loadError && (
        <div className="banner" role="alert">
          {connected ? (
            <>Couldn&apos;t load existing jobs — {loadError}. Live updates are still working.</>
          ) : (
            <>
              <strong>Can&apos;t reach the API at {API_URL}</strong>
              <span>
                Nothing is answering there. Start it with <code>npm start</code> in the
                project root, and <code>npm run worker</code> in a second terminal.
                This page will reconnect on its own.
              </span>
            </>
          )}
        </div>
      )}

      <StatsBar jobs={jobList} filter={filter} onFilter={setFilter} />

      <div className="main">
        <SubmitForm />
        <JobsTable
          jobs={visible}
          total={jobList.length}
          filter={filter}
          onClearFilter={() => setFilter(null)}
          loading={loading}
          now={now}
        />
      </div>

        <p className="foot">
          Jobs are claimed atomically, so running several workers at once is
          safe with no coordination between them. A worker that dies mid-job
          has its work reclaimed automatically once its lease expires.
        </p>
      </div>
    </>
  )
}
