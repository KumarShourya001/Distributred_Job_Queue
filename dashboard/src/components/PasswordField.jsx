import { useState } from "react"

// Shared by both auth pages. The reveal toggle and the Caps Lock warning are
// identical on each, and duplicating them is how two forms slowly drift apart.
export default function PasswordField({ id, value, onChange, autoComplete, invalid, describedBy }) {
  const [visible, setVisible] = useState(false)
  const [caps, setCaps] = useState(false)

  // getModifierState reports the live state of the key rather than the key that
  // was just pressed, so this catches Caps Lock that was already on before the
  // field was ever focused — the case that actually locks people out.
  const readCaps = (e) => setCaps(e.getModifierState?.("CapsLock") ?? false)

  return (
    <>
      <div className="pw-wrap">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyUp={readCaps}
          onKeyDown={readCaps}
          onBlur={() => setCaps(false)}
          autoComplete={autoComplete}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />

        {/* type="button" is load-bearing: a bare <button> inside a <form>
            defaults to type="submit", so revealing the password would submit
            the form instead. */}
        <button
          type="button"
          className="pw-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>

      {caps && (
        <p className="caps" role="status">Caps Lock is on</p>
      )}
    </>
  )
}
