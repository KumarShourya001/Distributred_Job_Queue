const express=require("express")
const router=express.Router()
const {handlers}=require("../worker/handlers")
const { z } = require("zod")
const { createJob, listJobs, getJob, jobStats, retryJob, cancelJob } = require("../services/jobService")

const jobTypes = Object.keys(handlers) ;
const schema=z.object({
    type: z.enum(jobTypes),
   payload: z.record(z.any()).default({}),
   runAt:z.coerce.date().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
   priority:z.coerce.number().int().default(0)

})


const listQuerySchema = z.object({
  status: z.enum(["pending", "claimed", "completed", "failed", "dead"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
})
router.get("/stats", async (req, res) => {
    res.json(await jobStats())
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
   const {job,created}=await createJob(result.data.type,result.data.payload,result.data.runAt,result.data.priority,result.data.idempotencyKey)
   
   res.status(created ? 202 : 200).json({id:job._id})


})
router.post("/:id/retry", async (req, res) => { 
    const job=await retryJob(req.params.id)
    if(job){
        return res.json(job)
    }
    const existing=await getJob(req.params.id)
    if(!existing){
        return res.status(404).json({error:"job not found"})
    }
    res.status(409).json({error:`cannot retry a ${existing.status} job`})
 })
 router.delete("/:id", async (req, res) => {
    const result = await cancelJob(req.params.id)

    if (result.deletedCount) {
        return res.sendStatus(204)
    }

    const existing = await getJob(req.params.id)
    if (!existing) {
        return res.status(404).json({ error: "job not found" })
    }

    res.status(409).json({ error: `cannot cancel a ${existing.status} job` })
})
module.exports=router