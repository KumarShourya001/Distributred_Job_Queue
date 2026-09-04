import { API_URL } from "./config"

// The single place that knows two things the rest of the app shouldn't have to
// remember: the session cookie only travels when credentials is "include", and
// this API reports failures inconsistently — 400s send {error}, a failed login
// sends {message}. Both pages read errors the same way because of this.
export async function postAuth(path, body) {
  const res = await fetch(`${API_URL}/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  })

  // logout answers 204 with no body at all, so an unguarded .json() throws.
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = {}
  }

  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (HTTP ${res.status})`)
  }
  return data
}

export const logout = () => postAuth("logout", {})
