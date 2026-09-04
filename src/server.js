
const config=require("./config")
const mongoose = require('mongoose')
const express=require('express')
const jobRoutes =require('./api/jobRoutes')
const { initWebSocket, closeWebSocket } = require("./ws")
const { watchJobChanges } = require("./changeStream")
const http=require('http')
const { requireAuth } = require('./middleware/requireAuth')
const {rateLimit}=require('./middleware/rateLimit')
const {traceids}=require('./middleware/traceid')
const authRoutes = require('./api/authRoutes')
const app=express()
const log = require("./loggers")
if (config.TRUST_PROXY !== false) app.set("trust proxy", config.TRUST_PROXY)
let server=null
let stream=null
let shuttingDown=false


app.use(traceids)

app.get("/health",(req,res)=>{
  const states=["disconnected", "connected", "connecting", "disconnecting"]
  const mongo=states[mongoose.connection.readyState]|| "unknown"
  const ok=mongoose.connection.readyState=== 1
  res.status(ok?200:503).json({
    status: ok?"ok":"degraded",
    mongo,
    uptime:Math.floor(process.uptime())
  })
})


const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', config.corsOrigin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Cache-Control', 'no-store');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-KEY');
    res.header("Vary","Origin");
    if(req.method==="OPTIONS"){
      return res.sendStatus(204)
    }
    next();
};
app.use(cors)
// Body parsing is scoped to /jobs and runs after the guards, so an unauthenticated or
// rate-limited request is never parsed. Any route added outside /jobs will see req.body
// as undefined.
app.use("/auth",rateLimit,express.json({limit:'16kb'}),authRoutes)
app.use("/jobs", rateLimit, requireAuth, express.json({limit:"16kb"}), jobRoutes)
app.use((err, req, res, next) => {
   if (err.name === "CastError") {
    return res.status(400).json({ error: "invalid id" })
  }
  const status = err.status ?? err.statusCode
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.expose ? err.message : "bad request" })
  }

  log.error("unhandled error", { err: err.message, traceId: req.traceId })
  res.status(500).json({ error: "internal server error" })
})
async function main() {
  log.info("connecting to mongo")
  await mongoose.connect(config.mongoUri)
  log.info("mongo connected")
  
  server = http.createServer(app) 
  server.on("error",(err)=>{
    log.error("server error", { err: err.message })
    process.exit(1)
  })
  initWebSocket(server)
  stream=watchJobChanges()
  server.listen(config.port,()=>log.info("listening", { port: config.port }))

}
async function shutdown(signal) {
  if(shuttingDown)return
  shuttingDown=true
  log.info("shutdown requested", { signal })
  const force=setTimeout(()=>{
    log.error("forced exit")
    process.exit(1)

  },10000)
  force.unref()
  const closed=new Promise((resolve)=>server.close(resolve))
  closeWebSocket()
  await closed
  if(stream)await stream.close()
  await mongoose.disconnect()
clearTimeout(force)
log.info("server stopped cleanly")
process.exit(0)

}
process.on("SIGTERM",()=>shutdown("SIGTERM"))
process.on("SIGINT",()=>shutdown("SIGINT"))


main().catch((err) => {
  console.error("failed to start:", err.message)
  process.exit(1)
})