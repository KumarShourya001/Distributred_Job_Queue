
const config=require("./config")
const mongoose = require('mongoose')
const express=require('express')
const jobRoutes =require('./api/jobRoutes')
const { initWebSocket } = require("./ws")
const { watchJobChanges } = require("./changeStream")
const http=require('http')
const app=express()
app.use(express.json())
app.use("/jobs",jobRoutes)

app.use((err, req, res, next) => {
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