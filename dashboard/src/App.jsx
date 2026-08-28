import { useEffect, useState } from "react"

const WS_URL = "ws://localhost:3000"

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
  const [jobs, setJobs] = useState({})     // id -> job
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const ws = new WebSocket(WS_URL)

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = (err) => console.error("ws error", err)

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data)
      if (!data.job) return
      setJobs((prev) => ({ ...prev, [data.job._id]: data.job }))
    }

    return () => ws.close()
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