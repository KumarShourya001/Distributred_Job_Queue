const { API_KEY } = require('../config')
const crypto=require('node:crypto')
function requireApiKey(req,res,next){
    if(req.method =="OPTIONS"){
        next()
        return
    }
    const presented=req.get("X-API-Key") 
    if(!presented){
        return res.status(401).json({error:"Unauthorized"})
    }
    const expected=API_KEY
    if(presented.length !== expected.length){
        return res.status(401).json({error:"Unauthorized"})
    }
    if(!crypto.timingSafeEqual(Buffer.from(presented),Buffer.from(expected))){
        return res.status(401).json({error:"Unauthorized"})
    }
    next()
}
module.exports={requireApiKey}