const jwt = require("jsonwebtoken");
const config = require("./config");

const SESSION_COOKIE = "session";

function sign(userId) {
  return jwt.sign({ sub: String(userId) }, config.JWT_SECRET, {
    expiresIn: config.SESSION_TTL,
  });
}
function verifyFull(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}
function verify(token) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    return payload.sub;
  } catch {
    return null;
  }
}

const cookieOptions = {
  httpOnly: true,
  secure: config.IS_PRODUCTION,
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

module.exports = { sign, verify, verifyFull,cookieOptions, SESSION_COOKIE };
