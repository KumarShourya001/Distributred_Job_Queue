
require("dotenv").config()

const mongoUri = process.env.MONGO_URI
const port = process.env.PORT || 3000
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173"

const allowedHosts = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
  : null

if (!mongoUri) {
  throw new Error("MONGO_URI is not set in .env")
}

module.exports = { mongoUri, port,corsOrigin ,allowedHosts}