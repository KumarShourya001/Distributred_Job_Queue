import { useEffect, useState } from "react"
import { API_URL, WS_URL } from "./lib/config"
import { logout as logoutRequest } from "./lib/auth"
import Masthead from "./components/Masthead"
import About from "./components/About"
import StatsBar from "./components/StatsBar"
import SubmitForm from "./components/SubmitForm"
import JobsTable from "./components/JobsTable"
import Login from "./components/Login"
import Signup from "./components/Signup"
import "./App.css"

// App owns only the state that more than one section needs: the jobs
// themselves, the connection status, and whether anyone is signed in.
// Form state lives inside each form.
export default function App() {
  const [jobs, setJobs] = useState({})
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [filter, setFilter] = useState(null)   // null = show everything

  // Three states, not a boolean. A boolean has to start at false, which means
  // the login screen flashes on every reload before the session check lands.
  const [authState, setAuthState] = useState("checking") // checking | in | out
  const [authView, setAuthView] = useState("login")      // login | signup
  const [notice, setNotice] = useState(null)

  async function load() {
    try {
      const res = await fetch(`${API_URL}/jobs?limit=100`, { credentials: "include" })

      // The session cookie is HttpOnly, so this request is the only way the page
      // can find out whether it is signed in - a 401 is an answer, not a failure.
      // Checking it on every load also means an expired session drops you back
      // to sign-in instead of silently showing an empty table.
      if (res.status === 401) {
        setAuthState("out")
        return
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()

      const fetched = Object.fromEntries(body.jobs.map((j) => [j._id, j]))
      // `fetched` spread LAST so the server wins: on a reconnect, what we held
      // while disconnected may be minutes stale.
      setJobs((prev) => ({ ...prev, ...fetched }))
      setAuthState("in")
      setLoadError(null)
    } catch (err) {
      setLoadError(err.message)
      // A dead API must not throw someone who is already working back to the
      // login screen. On the very first check there is nothing else to go on.
      setAuthState((s) => (s === "checking" ? "out" : s))
    } finally {
      setLoading(false)
    }
  }

  // 1. Load what already exists, once, on mount. This doubles as the session check.
  useEffect(() => {
    load()
  }, [])

  // 2. Stay current from here on, reconnecting if the socket drops.
  useEffect(() => {
    // Signed out, the server 401s the upgrade and destroys the socket. Without
    // this guard onclose fires immediately, the backoff below schedules a retry,
    // and the login screen quietly hammers the server for as long as it is open.
    if (authState !== "in") return

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
        load()
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
  }, [authState])

  // Keeps the Age column honest without re-rendering every second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(id)
  }, [])

  function handleAuthed() {
    setNotice(null)
    setLoading(true)
    setAuthState("in")
    load()
  }

  function handleCreated() {
    setNotice("Account created — sign in to continue.")
    setAuthView("login")
  }

  // Everything that has to happen when this page stops being signed in, whether
  // the user asked for it or the server just said 401.
  function clearSession() {
    // Dropped deliberately: without this the next account to sign in on this
    // machine sees the previous one's jobs until the first fetch returns.
    setJobs({})
    setFilter(null)
    setLoadError(null)
    setLoading(true)
    setAuthView("login")
    setAuthState("out")
  }

  async function handleLogout() {
    try {
      await logoutRequest()
    } catch {
      // The cookie may already be expired or cleared. Either way local state
      // decides what this page shows next, so there is nothing to recover from.
    }
    clearSession()
  }

  // Every hook above runs on every render; the gate below sits after all of
  // them so no hook is ever skipped.
  if (authState === "checking") return null

  if (authState === "out") {
    return authView === "signup" ? (
      <Signup
        onCreated={handleCreated}
        onSwitch={() => setAuthView("login")}
      />
    ) : (
      <Login
        onAuthed={handleAuthed}
        onSwitch={() => {
          setNotice(null) // a stale "account created" must not follow you to signup
          setAuthView("signup")
        }}
        notice={notice}
      />
    )
  }

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
      <Masthead connected={connected} onLogout={handleLogout} />
      <div className="shell">
        <About />

      {loadError && (
        <div className="banner" role="alert">
          {connected ? (
            <>Couldn&apos;t load existing jobs &mdash; {loadError}. Live updates are still working.</>
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
        <SubmitForm onSessionLost={clearSession} />
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
