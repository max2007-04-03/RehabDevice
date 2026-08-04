window.RehabGames = window.RehabGames || {};

window.RehabGames['pingpong'] = class PingPongGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        
        // Physics & State
        this.calibMin = -20;
        this.calibMax = 20;
        this.consecutiveHits = 0;
        
        // Canvas dimensions
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;
        
        // Game objects
        this.paddleW = 10;
        this.paddleH = 60;
        this.ballSize = 15;
        this.playerY = 0;
        this.botY = 0;
        this.ballX = 0;
        this.ballY = 0;
        this.ballVX = 0;
        this.ballVY = 0;
        this.currentBallSpeed = 0;
        this.botTargetY = 0;
        this.botReactionDelayTimer = 0;
    }
    
    init(calibMin, calibMax) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.consecutiveHits = 0;
        
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        this.resetBall();
        this.playerY = this.height / 2 - this.paddleH / 2;
        this.botY = this.height / 2 - this.paddleH / 2;
        
        this.updateHUD();
    }
    
    resize(width, height) {
        this.width = width;
        this.height = height;
        
        this.paddleW = Math.max(10, this.width * 0.015);
        this.paddleH = Math.max(60, this.height * 0.25);
        this.ballSize = Math.max(15, Math.min(35, this.width * 0.03));
    }
    
    resetBall() {
        this.ballX = this.width / 2;
        this.ballY = this.height / 2;
        this.currentBallSpeed = this.width * 0.012; // Adequate initial speed
        let angle = (Math.random() * Math.PI / 4) - Math.PI / 8; // Small random angle (-22.5 to 22.5 deg)
        let direction = Math.random() > 0.5 ? 1 : -1;
        this.ballVX = this.currentBallSpeed * Math.cos(angle) * direction;
        this.ballVY = this.currentBallSpeed * Math.sin(angle);
    }
    
    mapAngleToScreen(angle) {
        let clamped = Math.max(this.calibMin, Math.min(this.calibMax, angle));
        let normalized = (clamped - this.calibMin) / (this.calibMax - this.calibMin);
        // Handle division by zero edge case
        if (isNaN(normalized)) normalized = 0.5;
        return (1 - normalized) * (this.height - this.paddleH);
    }
    
    updateHUD(botStateMsg = null) {
        this.api.updateHUD("hudScore", `Успішні відбивання: ${this.consecutiveHits}`);
        if (botStateMsg) {
            this.api.updateHUD("hudBotState", `Стан: ${botStateMsg}`);
        }
    }
    
    syncCalibration() {
        this.api.updateCalibration(this.calibMin, this.calibMax);
    }
    
    update(dt, currentAngle) {
        let boundsChanged = false;
        // Tier 3: In-game Dynamic Calibration (Smoothly expand bounds)
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; boundsChanged = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; boundsChanged = true; }
        if (boundsChanged) {
            this.syncCalibration();
        }
        
        // Smooth paddle movement (Lerp)
        let targetPlayerY = this.mapAngleToScreen(currentAngle);
        if (!isNaN(targetPlayerY)) {
            this.playerY += (targetPlayerY - this.playerY) * 15 * dt;
        }
        
        this.ballX += this.ballVX * dt * 60;
        this.ballY += this.ballVY * dt * 60;
        
        // Wall collisions
        if (this.ballY <= 0) { this.ballY = 0; this.ballVY = Math.abs(this.ballVY); }
        if (this.ballY + this.ballSize >= this.height) { this.ballY = this.height - this.ballSize; this.ballVY = -Math.abs(this.ballVY); }
        
        // Smart Bot Logic (DDA)
        this.botReactionDelayTimer -= dt * 1000;
        if (this.botReactionDelayTimer <= 0 && this.ballVX > 0) {
            let delay = 300;
            let offset = 0;
            let maxSpeed = this.height * 0.01;
            let stateText = "";
            
            // auto-therapy
            delay = Math.max(100, 500 - (this.consecutiveHits * 40));
            offset = Math.max(0, this.paddleH * 0.4 - (this.consecutiveHits * (this.paddleH * 0.05)));
            maxSpeed = this.height * 0.006 + (this.consecutiveHits * 0.0005);
            stateText = `Адаптація (${Math.round(delay)}мс, Шв: ${(maxSpeed/this.height*100).toFixed(1)})`;
            
            this.botTargetY = this.ballY + (Math.random() * offset * 2 - offset) - this.paddleH / 2;
            this.botReactionDelayTimer = delay;
            this.updateHUD(stateText);
        }
        
        // Move bot smoothly towards target
        if (this.ballVX > 0) {
            let maxSpeed = this.height * 0.01;
            maxSpeed = this.height * 0.006 + (this.consecutiveHits * 0.0005);

            let diff = this.botTargetY - this.botY;
            if (Math.abs(diff) > 2) {
                let step = Math.sign(diff) * Math.min(Math.abs(diff), maxSpeed * dt * 60);
                this.botY += step;
            }
        }
        this.botY = Math.max(0, Math.min(this.height - this.paddleH, this.botY));
        
        // Paddle collisions (Classic Pong)
        let maxBallSpeed = this.width * 0.025; // Max speed limit
        let maxBounceAngle = (5 * Math.PI) / 12; // 75 degrees maximum bounce angle
        
        // Player (Left)
        if (this.ballX <= this.paddleW && this.ballX + this.ballSize >= 0 && this.ballY + this.ballSize >= this.playerY && this.ballY <= this.playerY + this.paddleH && this.ballVX < 0) {
            this.ballX = this.paddleW;
            
            let hitPos = (this.playerY + this.paddleH/2) - (this.ballY + this.ballSize/2);
            let normalizedHit = Math.max(-1, Math.min(1, hitPos / (this.paddleH/2)));
            let bounceAngle = normalizedHit * maxBounceAngle;
            
            this.currentBallSpeed = Math.min(this.currentBallSpeed * 1.05, maxBallSpeed);
            
            this.ballVX = this.currentBallSpeed * Math.cos(bounceAngle);
            this.ballVY = this.currentBallSpeed * -Math.sin(bounceAngle);
            
            this.consecutiveHits++;
            this.updateHUD();
        }
        
        // Bot (Right)
        if (this.ballX + this.ballSize >= this.width - this.paddleW && this.ballX <= this.width && this.ballY + this.ballSize >= this.botY && this.ballY <= this.botY + this.paddleH && this.ballVX > 0) {
            this.ballX = this.width - this.paddleW - this.ballSize;
            
            let hitPos = (this.botY + this.paddleH/2) - (this.ballY + this.ballSize/2);
            let normalizedHit = Math.max(-1, Math.min(1, hitPos / (this.paddleH/2)));
            let bounceAngle = normalizedHit * maxBounceAngle;
            
            this.currentBallSpeed = Math.min(this.currentBallSpeed * 1.05, maxBallSpeed);
            
            this.ballVX = this.currentBallSpeed * -Math.cos(bounceAngle);
            this.ballVY = this.currentBallSpeed * -Math.sin(bounceAngle);
        }
        
        // Score / Miss
        if (this.ballX < -this.ballSize * 2) {
            this.consecutiveHits = Math.max(0, this.consecutiveHits - 2); // Smoothly decay difficulty instead of instant reset
            let range = this.calibMax - this.calibMin;
            this.calibMax -= range * 0.05;
            this.calibMin += range * 0.05;
            this.updateHUD();
            this.syncCalibration();
            this.resetBall();
        } else if (this.ballX > this.width + this.ballSize * 2) {
            this.resetBall();
        }
    }
    
    draw() {
        const ctx = this.ctx;
        // Clear
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Center line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 15]);
        ctx.beginPath();
        ctx.moveTo(this.width / 2, 0);
        ctx.lineTo(this.width / 2, this.height);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Paddles
        ctx.fillStyle = '#00f2fe';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(0, this.playerY, this.paddleW, this.paddleH, 4); ctx.fill();
        } else {
            ctx.fillRect(0, this.playerY, this.paddleW, this.paddleH);
        }
        
        ctx.fillStyle = '#ff1744';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(this.width - this.paddleW, this.botY, this.paddleW, this.paddleH, 4); ctx.fill();
        } else {
            ctx.fillRect(this.width - this.paddleW, this.botY, this.paddleW, this.paddleH);
        }
        
        // Ball
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ffffff';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(this.ballX, this.ballY, this.ballSize, this.ballSize, this.ballSize/2); ctx.fill();
        } else {
            ctx.fillRect(this.ballX, this.ballY, this.ballSize, this.ballSize);
        }
        ctx.shadowBlur = 0;
    }
    
    stop() {
        // Any specific cleanup for Ping-Pong if needed
        // (Engine already clears HUD and stops the loop)
    }
};
