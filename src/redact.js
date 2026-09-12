
function redactJob(job){
    if(!job?.payload?.headers)return job;
    const redactedHeaders={}

    for(const [key,value] of Object.entries(job.payload.headers)){
         if (/^(authorization|cookie)$|key|token|secret|password/i.test(key)) {
            redactedHeaders[key] = "[redacted]";
        } else {
            redactedHeaders[key] = value;
        }
    }
    return {
        ...job,
        payload:{
            ...job.payload,
            headers:redactedHeaders,
        }
    }
}
module.exports={redactJob}