const { WebSocketServer } = require("ws")

let wss = null

function initWebSocket(server) {
    wss = new WebSocketServer({ server })
    wss.on("connection", (ws) => {
        console.log("dashboard client connected")
        ws.on("close", () => console.log("dashboard client disconnected"))
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

module.exports = { initWebSocket, broadcast }