
require("dotenv").config()

const mongoose = require('mongoose')
const Job=require("./src/models/Job")

async function main() {
    try{  
    await mongoose.connect(process.env.MONGO_URI)
      
    const job=await Job.create({
        type:"send_email",
        payload:{ to: "a@b.com"},
        status:"banana"

    })
    console.log(job)    
    }
    catch(err){
        console.log(err)
    }
    finally{
        await mongoose.disconnect()
    }
}


main()
