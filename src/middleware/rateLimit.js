const config=require('../config')
const { TokenBucket } = require('./TokenBucket')

const buckets = new Map()

setInterval(()=>{
    for(const [key,bucket] of buckets){
        if(bucket.isFull()){
            buckets.delete(key)
        }
    }
},60000).unref()

function rateLimit(req,res,next){
    const key=req.ip
    let bucket=buckets.get(key)
    if(!bucket){
        bucket=new TokenBucket(config.RATE_BURST,config.RATE_REFILL_PER_SEC)
        buckets.set(key,bucket)
    }
    if(bucket.allowRequest()){
        next()
        return
    }
    res.set("Retry-After",String(bucket.retryAfterSeconds()))
    return res.status(429).json({error:"too many requests"})
}

module.exports={rateLimit}
