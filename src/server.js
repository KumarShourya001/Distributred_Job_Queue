
const config=require("./config")
const mongoose = require('mongoose')
const express=require('express')
const jobRoutes =require('./api/jobRoutes')
const { initWebSocket } = require("./ws")
const { watchJobChanges } = require("./changeStream")
const http=require('http')
const app=express()
app.use(express.json())

const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:5173'); 
    
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