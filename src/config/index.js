require("dotenv").config();

const mongoUri = process.env.MONGO_URI;
const port = process.env.PORT || 3000;
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
const API_KEY = process.env.API_KEY || null;
const MAX_QUEUE_DEPTH = Number(process.env.MAX_QUEUE_DEPTH) || 10000;
const allowedHosts = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  : null;
const LOG_LEVELS = ["error", "warn", "info", "debug"];
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const RATE_BURST = Number(process.env.RATE_BURST) || 20;
const RATE_REFILL_PER_SEC = Number(process.env.RATE_REFILL_PER_SEC) || 2;
const MAX_SCHEDULED = Number(process.env.MAX_SCHEDULED || 5000);
const MAX_RUNAT_DAYS = Number(process.env.MAX_RUNAT_DAYS || 3);
const TRUST_PROXY = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false;
const JWT_SECRET = process.env.JWT_SECRET || null;
const SESSION_TTL = process.env.SESSION_TTL || "7d";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
if (!mongoUri) {
  throw new Error("MONGO_URI is not set in .env");
}
if (JWT_SECRET === null) {
  throw new Error("JWT_SECRET is not set in .env");
}
if (API_KEY === null) {
  throw new Error("API_KEY not Found");
}
if (!LOG_LEVELS.includes(LOG_LEVEL)) {
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} - got "${LOG_LEVEL}"`);
}
module.exports = {
  mongoUri,
  port,
  corsOrigin,
  allowedHosts,
  API_KEY,
  RATE_BURST,
  RATE_REFILL_PER_SEC,
  MAX_QUEUE_DEPTH,
  MAX_RUNAT_DAYS,
  MAX_SCHEDULED,
  TRUST_PROXY,
  JWT_SECRET,
  SESSION_TTL,
  NODE_ENV,
  IS_PRODUCTION,
  LOG_LEVEL,
};
