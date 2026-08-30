async function httpRequest(payload) {
    const { url, body } = payload

    if (!url) {
        throw new Error("http_request needs a url in the payload")
    }

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10000)
    })

    if (!res.ok) {
        throw new Error(`request failed: HTTP ${res.status}`)
    }

    return { status: res.status, url }
}

const handlers = {
    http_request: httpRequest
}

module.exports = { handlers }