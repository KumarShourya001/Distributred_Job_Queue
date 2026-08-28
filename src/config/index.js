
require("dotenv").config()

const mongoUri = process.env.MONGO_URI
const port = process.env.PORT || 3000

if (!mongoUri) {
  throw new Error("MONGO_URI is not set in .env")
}

module.exports = { mongoUri, port }