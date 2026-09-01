class TokenBucket {
    constructor(capacity, refillRate) {
        this.capacity = capacity
        this.tokens = capacity
        this.refillRate = refillRate
        this.lastRefillTime = Date.now()
    }

    refill() {
        const now = Date.now()
        const elapsed = (now - this.lastRefillTime) / 1000
        const newTokens = elapsed * this.refillRate
        this.tokens = Math.min(this.capacity, this.tokens + newTokens)
        this.lastRefillTime = now
    }

    allowRequest() {
        this.refill()
        if (this.tokens >= 1) {
            this.tokens--
            return true
        }
        return false
    }

    retryAfterSeconds() {
        this.refill()
        if (this.tokens >= 1) return 0
        return Math.ceil((1 - this.tokens) / this.refillRate)
    }

    isFull() {
        this.refill()
        return this.tokens >= this.capacity
    }
}

module.exports = { TokenBucket }
