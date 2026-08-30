import { useEffect, useState } from "react"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"
const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000"
const JOB_TYPES = ["http_request"]

function statusColor(status) {
  switch (status) {
    case "pending": return "#888"
    case "claimed": return "#d9a441"
    case "completed": return "#2e6b58"
    case "failed": return "#c0392b"
    case "dead": return "#555"
    default: return "#333"
  }
}

export default function App() {
  const [type, setType] = useState("http_request")
  const [payloadText, setPayloadText] = useState(`{
  "url": "https://webhook.site/e2cbff67-93cd-4d0a-8eaa-c85c0b01ab7b",
  "body": { "hello": "from my job queue" }
}`)
  const [submitError, setSubmitError] = useState(null)
  
  const [jobs, setJobs] = useState({})
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
   async function load() {
      try {
        const res = await fetch(`${API_URL}/jobs?limit=100`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const list = await res.json()
       

        const fetched = Object.fromEntries(list.map((j) => [j._id, j]))
        setJobs((prev) => ({ ...prev, ...fetched }))
        setLoadError(null)
      } catch (err) {
        setLoadError(err.message)
      } finally {
         setLoading(false)
      }
    }
    async function handleSubmit(e) {
      e.preventDefault()
      let payload
      try{
        payload=JSON.parse(payloadText)
      }catch(err){
       
        setSubmitError(err.message || "An unexpected error occured")
        return 
      }
      const res= await fetch(`${API_URL}/jobs`,{
         method:"POST",
        headers: { "Content-Type" : "application/json" },
        body:JSON.stringify({type,payload})
      }
      )
      if(!res.ok){
        const err=await res.json()
        setSubmitError (err.error || err.message || "FAILED")
        return
      }
      setSubmitError(null)

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

    function connect() {
      socket = new WebSocket(WS_URL)

      socket.onopen = () => {setConnected(true);load()}

      socket.onclose = () => {
        setConnected(false)
        if (!cancelled) timer = setTimeout(connect, 2000)
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

  const jobList = Object.values(jobs).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  )

  const pendingCount = jobList.filter((j) => j.status === "pending").length
  const claimedCount = jobList.filter((j) => j.status === "claimed").length
  const completedCount = jobList.filter((j) => j.status === "completed").length
  const deadCount = jobList.filter((j) => j.status === "dead").length

  return (
    <div style={{ fontFamily: "monospace", padding: 24, background: "#111", color: "#eee", minHeight: "100vh" }}>
      <h1>Job Queue Dashboard</h1>
      <p>WebSocket: {connected ? "connected" : "disconnected"}</p>

      {loadError && (
        <p style={{ color: "#c0392b" }}>
          Could not load existing jobs: {loadError}. Live updates still work.
        </p>
      )}
      <form onSubmit={handleSubmit}  style={{ display: "flex", flexDirection: "column", gap: 8, margin: "16px 0", maxWidth: 520 }} >
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ fontFamily: "monospace", padding: 6, background: "#1a1a1a", color: "#eee", border: "1px solid #444" }}
        >
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <textarea
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          rows={6}
          spellCheck={false}
          style={{ fontFamily: "monospace", padding: 8, background: "#1a1a1a", color: "#eee", border: "1px solid #444", resize: "vertical" }}
        />

        <button
          type="submit"
          style={{ fontFamily: "monospace", padding: "8px 16px", background: "#2e6b58", color: "#eee", border: "none", cursor: "pointer", alignSelf: "flex-start" }}
        >
          Submit job
        </button>

        {submitError && <p style={{ color: "#c0392b", margin: 0 }}>{submitError}</p>}
      </form>
      <div style={{ display: "flex", gap: 24, margin: "16px 0" }}>
        <Stat label="pending" value={pendingCount} />
        <Stat label="claimed" value={claimedCount} />
        <Stat label="completed" value={completedCount} />
        <Stat label="dead" value={deadCount} />
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #444" }}>
            <th>id</th>
            <th>type</th>
            <th>status</th>
            <th>attempts</th>
          </tr>
        </thead>
        <tbody>
          {jobList.map((job) => (
            <tr key={job._id} style={{ borderBottom: "1px solid #222" }}>
              <td>{job._id.slice(-6)}</td>
              <td>{job.type}</td>
              <td style={{ color: statusColor(job.status) }}>{job.status}</td>
              <td>{job.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {loading && <p style={{ color: "#888", marginTop: 16 }}>Loading…</p>}
      {!loading && !loadError && jobList.length === 0 && (
        <p style={{ color: "#888", marginTop: 16 }}>No jobs yet. Submit one to see it appear.</p>
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div style={{ border: "1px solid #444", padding: "8px 16px" }}>
      <div style={{ fontSize: 12, color: "#888" }}>{label}</div>
      <div style={{ fontSize: 24 }}>{value}</div>
    </div>
  )
}