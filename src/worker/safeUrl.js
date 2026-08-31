const dns = require("node:dns").promises
const net = require("node:net")
const config = require("../config")
const { PermanentError } = require("./errors")

function toInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
}

const BLOCKED_V4 = [
  ["0.0.0.0", "0.255.255.255"],          // "this host"
  ["10.0.0.0", "10.255.255.255"],        // RFC1918 private
  ["100.64.0.0", "100.127.255.255"],     // carrier-grade NAT
  ["127.0.0.0", "127.255.255.255"],      // loopback -- our own API and Mongo
  ["169.254.0.0", "169.254.255.255"],    // link-local -- cloud metadata lives here
  ["172.16.0.0", "172.31.255.255"],      // RFC1918 private
  ["192.0.0.0", "192.0.0.255"],          // IETF protocol assignments
  ["192.168.0.0", "192.168.255.255"],    // RFC1918 private
  ["198.18.0.0", "198.19.255.255"],      // benchmarking
  ["224.0.0.0", "255.255.255.255"]       // multicast, reserved, broadcast
].map(([lo, hi]) => [toInt(lo), toInt(hi)])

function isBlockedAddress(ip){
    const family=net.isIP(ip)
    if(family==0)return true
    if (family==4){
        const n=toInt(ip)
        return BLOCKED_V4.some(([lo,hi])=>n>=lo && n<=hi)
    }
    const addr=ip.toLowerCase().split("%")[0]
    const mapped=addr.match(/^::ffff:(.+)$/)
    if(mapped){
        const tail=mapped[1]
        if(net.isIP(tail)===4)return isBlockedAddress(tail)
            const hex=tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
        if(hex){
            const n=((parseInt(hex[1],16)<<16)>>>0)+parseInt(hex[2],16)
            return isBlockedAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."))
        }
        return true
    }
    if(addr==="::1" || addr==="::")return true
    if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true
    if (/^fe[89ab][0-9a-f]:/.test(addr)) return true 
     return false
}
async function assertSafeUrl(rawUrl) {
    if(typeof rawUrl !=="string" || rawUrl.trim()===""){
        throw new PermanentError("url must be a non empty string")
    }
    let parsed
    try{
        parsed=new URL(rawUrl)
    }
    catch{
        throw new PermanentError(`url is not Valid:${rawUrl}`)
    }
    if(parsed.protocol!=="http:" && parsed.protocol!=="https:"){
        throw new PermanentError(`blocked protocol ${parsed.protocol}`)
    }
    const hostname=parsed.hostname.replace(/^\[|\]$/g,"")
    if(config.allowedHosts){
        if(!config.allowedHosts.includes(hostname.toLowerCase())){
            throw new PermanentError(`host not in Allowed host: ${hostname}`)
        }
        return parsed
    }
    if(net.isIP(hostname)){
        if(isBlockedAddress(hostname)){
            throw new PermanentError(`Blocked address: ${hostname}`)
        }
        return parsed
    }
    let addresses
    try{
        addresses=await dns.lookup(hostname,{all:true})

    }catch{
        throw new Error(`could not resolve host: ${hostname}`)
    }
    if(addresses.length===0){
        throw new Error(`host resolved to no addresses: ${hostname}`)
    }
    for (const{address} of addresses){
        if(isBlockedAddress(address)){
            throw new PermanentError(`host ${hostname} resolves to blocked address ${address}`)
        }
    }
    return parsed
}

module.exports={assertSafeUrl,isBlockedAddress}