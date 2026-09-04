import { useState } from "react"
import { postAuth } from "../lib/auth"
import PasswordField from "./PasswordField"
import "./Auth.css"

// `notice` carries the "account created" line over from the signup page. It is
// a prop rather than local state because the page that raises it unmounts the
// moment it does — the message has to outlive its sender.
export default function Login({ onAuthed, onSwitch, notice }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return

    const trimmed = email.trim()
    if (!trimmed || !password) {
      setError("Enter your email and password.")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await postAuth("login", { email: trimmed, password })
      onAuthed()
      // No setSubmitting(false) on success, and no finally block: onAuthed
      // swaps this whole screen out. Re-enabling the button first would flash
      // "Sign in" for a frame right as the dashboard replaces it.
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-col">
        <div className="auth-brand">
          <span className="mark" aria-hidden="true">JQ</span>
          <span className="name">Distributed Job Queue</span>
        </div>

        <div className="auth-card">
          <div>
            <h1>Sign in</h1>
            <p className="sub">Your queue only shows jobs you submitted.</p>
          </div>

          {/* noValidate hands error reporting to the messages below. Without it
              the browser's own bubbles fire first and say something different. */}
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                aria-invalid={error ? true : undefined}
              />
            </div>

            <div className="auth-field">
              <label htmlFor="login-password">Password</label>
              <PasswordField
                id="login-password"
                value={password}
                onChange={setPassword}
                // "current-password" tells a manager to offer a saved entry.
                // "new-password" here would make it offer to generate one.
                autoComplete="current-password"
                invalid={error ? true : undefined}
              />
            </div>

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>

            {error && (
              <p className="auth-msg" data-tone="error" role="alert">{error}</p>
            )}
            {notice && !error && (
              <p className="auth-msg" data-tone="ok" role="status">{notice}</p>
            )}
          </form>

          <p className="auth-alt">
            Don&apos;t have an account?{" "}
            <button type="button" onClick={onSwitch}>Create one</button>
          </p>
        </div>
      </div>

      <p className="auth-foot">
        Sessions last 7 days and are held in an HttpOnly cookie, so page
        JavaScript can never read your token.
      </p>
    </div>
  )
}
