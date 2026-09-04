import { useState } from "react"
import { postAuth } from "../lib/auth"
import PasswordField from "./PasswordField"
import "./Auth.css"

// Mirrors MIN_AGE_MS in authController.js. Kept as a constant so the message
// below and the check can never disagree about the number.
const MIN_AGE = 13

// The latest date of birth that still clears MIN_AGE, in the yyyy-mm-dd form a
// date input wants. Used as the `max` attribute so the picker greys out the
// dates the server would reject rather than letting someone choose one first.
function latestAllowedDob() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - MIN_AGE)
  return d.toISOString().slice(0, 10)
}

export default function Signup({ onCreated, onSwitch }) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [dob, setDob] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return

    const trimmed = email.trim()
    const trimmedName = name.trim()

    // Checked here because the API answers every malformed body with a flat
    // 400 {error:"invalid request body"} — true, but useless to read. These
    // mirror registerSchema in authController.js; if that changes, change these.
    if (!trimmedName) {
      setError("Enter your name.")
      return
    }
    if (trimmedName.length > 80) {
      setError("Name must be 80 characters or fewer.")
      return
    }
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.")
      return
    }
    if (!dob) {
      setError("Enter your date of birth.")
      return
    }
    // A typed-in date beats the picker's `max`, so the age gate is enforced
    // here too rather than trusting the widget.
    if (dob > latestAllowedDob()) {
      setError(`You must be at least ${MIN_AGE} to create an account.`)
      return
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password.length > 200) {
      setError("Password must be 200 characters or fewer.")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await postAuth("register", { email: trimmed, password, name: trimmedName, dob })
      // Registering does not set a session cookie, so there is nothing to log
      // in with yet — this hands off to the sign-in page rather than pretending.
      onCreated()
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
            <h1>Create an account</h1>
            <p className="sub">Takes a few seconds. No email confirmation needed.</p>
          </div>

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="signup-name">Name</label>
              <input
                id="signup-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                autoFocus
                aria-invalid={error ? true : undefined}
              />
            </div>

            <div className="auth-field">
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                aria-invalid={error ? true : undefined}
              />
            </div>

            <div className="auth-field">
              <label htmlFor="signup-dob">Date of birth</label>
              <input
                id="signup-dob"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                autoComplete="bday"
                max={latestAllowedDob()}
                aria-invalid={error ? true : undefined}
                aria-describedby="signup-dob-hint"
              />
              <span className="hint" id="signup-dob-hint">
                You must be at least {MIN_AGE}.
              </span>
            </div>

            <div className="auth-field">
              <label htmlFor="signup-password">Password</label>
              <PasswordField
                id="signup-password"
                value={password}
                onChange={setPassword}
                // Signals a password manager to offer a generated password
                // rather than autofilling an existing one.
                autoComplete="new-password"
                invalid={error ? true : undefined}
                describedBy="signup-password-hint"
              />
              {/* Stated before they type, not after they fail. */}
              <span className="hint" id="signup-password-hint">
                At least 8 characters.
              </span>
            </div>

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </button>

            {error && (
              <p className="auth-msg" data-tone="error" role="alert">{error}</p>
            )}
          </form>

          <p className="auth-alt">
            Already have an account?{" "}
            <button type="button" onClick={onSwitch}>Sign in</button>
          </p>
        </div>
      </div>

      <p className="auth-foot">
        Passwords are hashed with bcrypt before they are stored. The plaintext
        is never written anywhere.
      </p>
    </div>
  )
}
