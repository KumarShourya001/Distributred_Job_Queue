
const config=require("./config")
const mongoose = require('mongoose')
const express=require('express')
const jobRoutes =require('./api/jobRoutes')
const { initWebSocket } = require("./ws")
const { watchJobChanges } = require("./changeStream")
const http=require('http')
const app=express()

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
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
  
  const server = http.createServer(app) 
  initWebSocket(server)
  watchJobChanges()
  server.listen(config.port,()=>console.log(`listen on ${config.port}`))

}
main()