import "./About.css"

export default function About() {
  return (
    <section className="about">
      <div>
        <h3>What this is</h3>
        <p>
          A job queue built on MongoDB. The API accepts work and returns
          immediately; separate worker processes do the actual work later.
        </p>
      </div>

      <div>
        <h3>Try it</h3>
        <p>
          Pick a type: post to a URL from{" "}
          <a href="https://webhook.site" target="_blank" rel="noreferrer">
            webhook.site
          </a>
          , email yourself, or pull the text out of any public page. A worker
          does the work, not the API.
        </p>
      </div>

      <div>
        <h3>What to watch</h3>
        <p>
          Status moves <em>pending → claimed → completed</em>. Point it at a
          broken URL instead and watch it retry three times, then turn{" "}
          <span className="dead-word">dead</span>.
        </p>
      </div>
    </section>
  )
}
