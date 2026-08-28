const express=require("express")
const router=express.Router()
const { z } = require("zod")
const { createJob, listJobs, getJob } = require("../services/jobService")
const schema=z.object({
    type: z.string().min(1),
   payload: z.record(z.any()).default({})
})

const listQuerySchema = z.object({
  status: z.enum(["pending", "claimed", "completed", "failed", "dead"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
})

router.get("/",async(req,res)=>{
   
    const result=listQuerySchema.safeParse(req.query)
    if(!result.success){
         return res.status(400).json({ error: "invalid request query" })
    }
    const {status,limit}=result.data
    const filter=status?{status}:{}
    const jobs=await listJobs(filter,limit)
    res.json(jobs)
    
})

router.get("/:id",async(req,res)=>{
    const job=await getJob(req.params.id)
    if(!job){
        return res.status(404).json({error:"job not found"})
    }
    res.json(job)
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