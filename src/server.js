
const config=require("./config")
const mongoose = require('mongoose')
const express=require('express')
const jobRoutes =require('./api/jobRoutes')
const { initWebSocket, closeWebSocket } = require("./ws")
const { watchJobChanges } = require("./changeStream")
const http=require('http')
const app=express()
let server=null
let stream=null
let shuttingDown=false
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

app.use(express.json())

const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', config.corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.header("Vary","Origin");
    if(req.method==="OPTIONS"){
      return res.sendStatus(204)
    }
    next();
};
app.use(cors)
app.use("/jobs",jobRoutes)

app.use((err, req, res, next) => {
   if (err.name === "CastError") {
    return res.status(400).json({ error: "invalid id" })
  }
  console.error(err)
  res.status(500).json({ error: "internal server error" })
})
async function main() {
  console.log("connecting...")
  await mongoose.connect(config.mongoUri)
  console.log("connected")
  
  server = http.createServer(app) 
  server.on("error",(err)=>{
    console.error("server error:",err.message)
    process.exit(1)
  })
  initWebSocket(server)
  stream=watchJobChanges()
  server.listen(config.port,()=>console.log(`listen on ${config.port}`))

}
async function shutdown(signal) {
  if(shuttingDown)return
  shuttingDown=true
  console.log(signal,"received - shutting down")
  const force=setTimeout(()=>{
    console.error("forced exit")
    process.exit(1)

  },10000)
  force.unref()
  const closed=new Promise((resolve)=>server.close(resolve))
  closeWebSocket()
  await closed
  if(stream)await stream.close()
  await mongoose.disconnect()
clearTimeout(force)
console.log("server stopped cleanly")
process.exit(0)

}
process.on("SIGTERM",()=>shutdown("SIGTERM"))
process.on("SIGINT",()=>shutdown("SIGINT"))


main().catch((err) => {
  console.error("failed to start:", err.message)
  process.exit(1)
})