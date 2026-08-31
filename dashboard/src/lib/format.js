// A job's `result` is an object: {status, url} on success, {error} on failure,
// null while pending. Pull out the part a person needs instead of dumping raw
// JSON into a table cell.
export function resultText(job) {
  const r = job.result
  if (!r) return null
  if (r.error) return r.error
  if (r.status) return `HTTP ${r.status}`
  return JSON.stringify(r)
}

export function isError(job) {
  return Boolean(job.result && job.result.error)
}

// `now` is passed in rather than read here, so every row in one render agrees
// on the current time and the caller controls how often it ticks.
export function timeAgo(iso, now) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
