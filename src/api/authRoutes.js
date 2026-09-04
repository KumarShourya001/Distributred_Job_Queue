const express=require('express')
const router = express.Router()
const {register:registerUser,login:loginUser,logout:logoutUser}=require('../controllers/authController')

router.post("/register",registerUser)
router.post("/login",loginUser)
router.post("/logout",logoutUser)
module.exports=router