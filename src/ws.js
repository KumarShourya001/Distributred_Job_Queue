const { WebSocketServer } = require("ws")
const config=require('./config')
const log = require("./loggers")
const { readSessionPayload } = require("./middleware/requireSession")

let wss = null

function initWebSocket(server) {
    wss = new WebSocketServer({ noServer:true })
    server.on("upgrade",(req,socket,head)=>{

        if(req.headers.origin!==config.corsOrigin){
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
            socket.destroy()
            return
        }
          const payload = readSessionPayload(req)  
        if(payload===null){
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
            socket.destroy()
            return
        }
        wss.handleUpgrade(req,socket,head,(ws)=>{
            ws.userId=payload.sub
            const timer=setTimeout(()=>ws.close(4001,'session expired'),Math.min(payload.exp*1000-Date.now(),2147483647))
            ws.on("close",()=>clearTimeout(timer))
            wss.emit("connection",ws,req)
        })
    })
    
    wss.on("connection", (ws) => {
    log.debug("dashboard client connected")
    ws.on("close", () => log.debug("dashboard client disconnected"))
})
}

function broadcast(event) {
    if (!wss) return
    const payload = JSON.stringify(event)
    const owner = event.job && event.job.ownerId ? String(event.job.ownerId) : null

    wss.clients.forEach((client) => {
        if (client.readyState !== 1) return
        if (event.job && client.userId !== owner) return
        client.send(payload)
    })
}
function closeWebSocket(){
    if(!wss)return
    wss.clients.forEach((client)=>client.close(1001,"server shutting down"))
    wss.close()
}
module.exports = { initWebSocket, broadcast,closeWebSocket }