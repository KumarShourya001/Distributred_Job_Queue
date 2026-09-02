const { WebSocketServer } = require("ws")

const log = require("./loggers")
let wss = null

function initWebSocket(server) {
    wss = new WebSocketServer({ server })
    wss.on("connection", (ws) => {
        log.debug("dashboard client connected")
        ws.on("close", () => log.debug("dashboard client disconnected"))
    })
}

function broadcast(event) {
    if (!wss) return
    const payload = JSON.stringify(event)
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload)
        }
    })
}
function closeWebSocket(){
    if(!wss)return
    wss.clients.forEach((client)=>client.close(1001,"server shutting down"))
    wss.close()
}
module.exports = { initWebSocket, broadcast,closeWebSocket }