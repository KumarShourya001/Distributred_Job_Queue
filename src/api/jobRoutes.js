const express=require("express")
const router=express.Router()
const {createJob}=require("../services/jobService")
const { z } = require("zod")

const schema=z.object({
    type: z.string().min(1),
   payload: z.record(z.any()).default({})
})

router.post("/",async(req,res)=>{
    const result = schema.safeParse(req.body)
    if(!result.success){
        return res.status(400).json({ error: "invalid request body" })
    }
   const job=await createJob(result.data.type,result.data.payload)
   
   res.status(202).json({id:job._id})


})

module.exports=router