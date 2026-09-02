const config = require("./config");
const LEVELS = new Map();
LEVELS.set("error", 50);
LEVELS.set("warn", 40);
LEVELS.set("info", 30);
LEVELS.set("debug", 20);

const threshold = LEVELS.get(config.LOG_LEVEL);

function logger(level, msg, fields) {
  if (LEVELS.get(level) < threshold) return;
  const record = { ...fields, time: new Date().toISOString(), level, msg };
  console.log(JSON.stringify(record));
  return record;
}

const error = (msg, field) => logger("error", msg, field);
const warn = (msg, field) => logger("warn", msg, field);
const info = (msg, field) => logger("info", msg, field);
const debug = (msg, field) => logger("debug", msg, field);

module.exports = { error, warn, info, debug };
