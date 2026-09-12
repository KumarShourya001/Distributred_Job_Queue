const { assertSafeUrl } = require("./safeUrl") 
const { PermanentError } = require("./errors")
const config=require('../config')

const METHODS = new Set(["GET","POST","PUT","PATCH","DELETE"])

async function SendEmail(payload) {
    const{to,subject,text}=payload
    if(!config.RESEND_API_KEY || !config.MAIL_FROM){
       throw new PermanentError("email is not configured")
    }
    if(!to || !subject || !text){
        throw new PermanentError("send_email needs to, subject and text")
    }
    const res=await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{
            "Authorization":  `Bearer ${config.RESEND_API_KEY}`,
            "Content-Type":"application/json"
        },
        body:JSON.stringify({from: config.MAIL_FROM,to ,subject,text}),
        signal:AbortSignal.timeout(10000)
    })
    if(res.status===429 || res.status>=500){
        throw new Error(`resend${res.status}`)
        
    }
    if(!res.ok){
        throw new PermanentError(`resend ${res.status}`)
    }
    const data=await res.json()
    return {id:data.id}
    
}

async function httpRequest(payload) {
    const { url, body ,method,headers} = payload
    const m=method??"POST"
    if (!url) {
        throw new PermanentError("http_request needs a url in the payload")
    }
    if(!METHODS.has(m)){
        throw new PermanentError(`Unsupported HTTP method : ${m}`)
    }
   const options = {
    method: m,
    headers: { 'Content-Type': "application/json", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(10000)
}
    if(m!=="GET"){
        options.body=JSON.stringify(body)
    }

    await assertSafeUrl(url)
    const res = await fetch(url,options)

    if(res.status>=300 && res.status<400){
        throw new PermanentError(`redirect refused: HTTP ${res.status} to ${res.headers.get("location") ?? "unknown"}`)    }
    if (!res.ok) {
        throw new Error(`request failed: HTTP ${res.status}`)
    }
    
    return { status: res.status, url }
}

const FETCH_MAX_BYTES = 1000000
const FETCH_MAX_CHARS = 10000
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function htmlToText(html) {
    return html
        .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e])
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim()
}

async function readBounded(res, limit) {
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    let truncated = false
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) {
            chunks.push(value.subarray(0, value.length - (size - limit)))
            truncated = true
            await reader.cancel()
            break
        }
        chunks.push(value)
    }
    return { buf: Buffer.concat(chunks), truncated }
}

async function fetchContent(payload) {
    const { url } = payload
    if (!url) {
        throw new PermanentError("fetch_content needs a url in the payload")
    }
    await assertSafeUrl(url)
    const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/html, text/plain;q=0.9" },
        redirect: "manual",
        signal: AbortSignal.timeout(10000)
    })
    if (res.status >= 300 && res.status < 400) {
        throw new PermanentError(`redirect refused: HTTP ${res.status} to ${res.headers.get("location") ?? "unknown"}`)
    }
    if (!res.ok) {
        throw new Error(`request failed: HTTP ${res.status}`)
    }
    const type = (res.headers.get("content-type") || "").toLowerCase()
    if (!type.startsWith("text/html") && !type.startsWith("text/plain")) {
        await res.body?.cancel()
        throw new PermanentError(`unsupported content-type: ${type || "none"}`)
    }
    const { buf, truncated } = await readBounded(res, FETCH_MAX_BYTES)
    const raw = buf.toString("utf8")
    const title = type.startsWith("text/html")
        ? htmlToText(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\n/g, " ")
        : ""
    const text = type.startsWith("text/html") ? htmlToText(raw) : raw.trim()
    return {
        url,
        status: res.status,
        title,
        bytes: buf.length,
        chars: text.length,
        truncated: truncated || text.length > FETCH_MAX_CHARS,
        text: text.slice(0, FETCH_MAX_CHARS)
    }
}

async function sleepJob(payload) {
    const ms = Number(payload.ms)

    if (!Number.isFinite(ms) || ms < 0) {
        throw new PermanentError("sleep needs a non-negative ms in the payload")
    }
    if (ms > 30000) {
        throw new PermanentError("sleep ms is capped at 30000")
    }

    await new Promise((resolve) => setTimeout(resolve, ms))

    return { sleptMs: ms }
}

async function fail(payload) {
    throw new Error(payload.message||"simulated failure")
}

const handlers = {
    http_request: httpRequest,
    sleep: sleepJob,
    fail:fail,
    send_email: SendEmail,
    fetch_content: fetchContent,
}

module.exports = { handlers }