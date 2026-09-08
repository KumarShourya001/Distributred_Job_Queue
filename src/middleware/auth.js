const { API_KEY } = require('../config')
const crypto = require('node:crypto')

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest()

function hasValidApiKey(req) {
    const presented = req.get("X-API-Key")
    if (!presented) return false
    return crypto.timingSafeEqual(digest(presented), digest(API_KEY))
}

function requireApiKey(req, res, next) {
    if (req.method === "OPTIONS") {
        next()
        return
    }
    if (!hasValidApiKey(req)) {
        return res.status(401).json({ error: "Unauthorized" })
    }
    next()
}

module.exports = { requireApiKey, hasValidApiKey }
