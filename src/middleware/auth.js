const { API_KEY } = require('../config')
const crypto = require('node:crypto')

function hasValidApiKey(req) {
    const presented = req.get("X-API-Key")
    if (!presented) return false
    if (presented.length !== API_KEY.length) return false
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(API_KEY))
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
