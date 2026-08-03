window.RehabGames = window.RehabGames || {};

window.RehabGames['cardodge'] = class CarDodgeGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        
        // Physics & State
        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = 'auto'; 
        
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;
        
        this.roadMargin = Math.max(20, this.width * 0.05);
        this.laneCount = 5;
        this.roadLeft = this.roadMargin;
        this.roadRight = this.width - this.roadMargin;
        this.laneWidth = (this.roadRight - this.roadLeft) / this.laneCount;
        
        this.player = {
            x: this.laneCenterX(2),
            y: this.height - Math.max(110, this.height * 0.15),
            w: Math.max(30, this.width * 0.08),
            h: Math.max(50, this.height * 0.1),
            hitCooldown: 0
        };
        
        this.enemies = [];
        this.score = 0;
        this.scoreAccum = 0;
        this.speed = 4;
        this.spawnTimer = 0;
        this.spawnInterval = 65;
        this.roadOffset = 0;
        this.flashTimer = 0;
    }

    laneCenterX(lane) {
        return this.roadLeft + this.laneWidth * lane + this.laneWidth / 2;
    }

    init(calibMin, calibMax, difficulty) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.difficulty = difficulty || 'auto';
        
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        this.resetGame();
        this.updateHUD();
    }
    
    resetGame() {
        this.player.x = this.laneCenterX(2);
        this.player.hitCooldown = 0;
        this.enemies = [];
        this.score = 0;
        this.scoreAccum = 0;
        this.speed = 4;
        this.spawnTimer = 0;
        this.spawnInterval = 65;
        this.roadOffset = 0;
        this.flashTimer = 0;
    }
    
    resize(width, height) {
        this.width = width;
        this.height = height;
        
        this.roadMargin = Math.max(20, this.width * 0.05);
        this.roadLeft = this.roadMargin;
        this.roadRight = this.width - this.roadMargin;
        this.laneWidth = (this.roadRight - this.roadLeft) / this.laneCount;
        
        this.player.y = this.height - Math.max(80, this.height * 0.15);
        this.player.w = Math.max(30, this.width * 0.06);
        this.player.h = Math.max(50, this.height * 0.12);
    }
    
    mapAngleToScreen(angle) {
        let clamped = Math.max(this.calibMin, Math.min(this.calibMax, angle));
        let normalized = (clamped - this.calibMin) / (this.calibMax - this.calibMin);
        if (isNaN(normalized)) normalized = 0.5;
        
        let minX = this.roadLeft + this.player.w / 2;
        let maxX = this.roadRight - this.player.w / 2;
        return minX + normalized * (maxX - minX);
    }
    
    syncCalibration() {
        this.api.updateCalibration(this.calibMin, this.calibMax);
    }
    
    updateHUD() {
        this.api.updateHUD("hudScore", `Счёт: ${this.score}`);
        let diffText = this.difficulty;
        if(diffText === 'auto') diffText = 'Адаптивна';
        else if(diffText === 'easy') diffText = 'Повільний';
        else if(diffText === 'medium') diffText = 'Стандарт';
        else if(diffText === 'hard') diffText = 'Швидкий';
        this.api.updateHUD("hudBotState", `Складність: ${diffText}`);
    }
    
    spawnEnemy() {
        const lane = Math.floor(Math.random() * this.laneCount);
        const colors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12'];
        this.enemies.push({
            x: this.laneCenterX(lane),
            y: -this.player.h,
            w: this.player.w,
            h: this.player.h,
            color: colors[Math.floor(Math.random() * colors.length)]
        });
    }
    
    rectsOverlap(a, b) {
        return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 4 &&
               Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 4;
    }
    
    penalize() {
        if (this.player.hitCooldown > 0) return;
        this.score -= 5;
        if (this.score < 0) this.score = 0;
        this.player.hitCooldown = 40; 
        this.flashTimer = 0.3; // seconds
        this.updateHUD();
    }
    
    update(dt, currentAngle) {
        let boundsChanged = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; boundsChanged = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; boundsChanged = true; }
        if (boundsChanged) {
            this.syncCalibration();
        }
        
        let targetX = this.mapAngleToScreen(currentAngle);
        if (!isNaN(targetX)) {
            // Smooth lerp for position
            this.player.x += (targetX - this.player.x) * 10 * dt;
        }
        
        const minX = this.roadLeft + this.player.w / 2;
        const maxX = this.roadRight - this.player.w / 2;
        this.player.x = Math.max(minX, Math.min(maxX, this.player.x));
        
        if (this.player.hitCooldown > 0) this.player.hitCooldown -= dt * 60;
        
        // Setup difficulty speed modifiers
        let diffMod = 1.0;
        if (this.difficulty === 'easy') diffMod = 0.6;
        else if (this.difficulty === 'medium') diffMod = 0.9;
        else if (this.difficulty === 'hard') diffMod = 1.4;
        
        let frameSpeed = this.speed * diffMod * (dt * 60);
        
        this.roadOffset += frameSpeed;
        if (this.roadOffset > 40) this.roadOffset = 0;
        
        this.spawnTimer += dt * 60;
        if (this.spawnTimer >= this.spawnInterval / diffMod) {
            this.spawnTimer = 0;
            this.spawnEnemy();
            if (this.spawnInterval > 32) this.spawnInterval -= 0.4;
        }
        
        for (let en of this.enemies) en.y += frameSpeed;
        this.enemies = this.enemies.filter(en => en.y < this.height + 100);
        
        for (let en of this.enemies) {
            if (this.rectsOverlap(this.player, en)) {
                this.penalize();
            }
        }
        
        // score accum
        this.scoreAccum += dt;
        if (this.scoreAccum >= 1.0) { // 1 per sec
            this.scoreAccum -= 1.0;
            this.score += 1;
            this.updateHUD();
        }
        this.speed = 4 + Math.min(this.score, 200) / 60;
        
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
        }
    }
    
    drawCar(x, y, w, h, bodyColor) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-w/2 + 3, -h/2 + 4, w, h);
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w/2, -h/2, w, h, 8);
        } else {
            ctx.rect(-w/2, -h/2, w, h);
        }
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillRect(-w/2 + 6, -h/2 + 10, w - 12, 16);
        ctx.fillRect(-w/2 + 6, h/2 - 26, w - 12, 16);
        ctx.fillStyle = '#fff59d';
        ctx.fillRect(-w/2 + 4, -h/2 + 2, 8, 5);
        ctx.fillRect(w/2 - 12, -h/2 + 2, 8, 5);
        ctx.restore();
    }
    
    draw() {
        const ctx = this.ctx;
        
        // Background
        ctx.fillStyle = '#555';
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Margins
        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(0, 0, this.roadMargin, this.height);
        ctx.fillRect(this.width - this.roadMargin, 0, this.roadMargin, this.height);
        
        // Grass lines
        ctx.fillStyle = '#5d4037';
        let roadOffset = this.roadOffset % 40;
        for (let y = -40 + roadOffset; y < this.height; y += 40) {
            ctx.fillRect(4, y, this.roadMargin - 8, 20);
            ctx.fillRect(this.width - this.roadMargin + 4, y, this.roadMargin - 8, 20);
        }
        
        // Road lanes
        ctx.strokeStyle = '#f5f5f5';
        ctx.lineWidth = 3;
        ctx.setLineDash([22, 18]);
        for (let i = 1; i < this.laneCount; i++) {
            const x = this.roadLeft + this.laneWidth * i;
            ctx.beginPath();
            ctx.moveTo(x, roadOffset - 40);
            ctx.lineTo(x, this.height);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        
        // Draw enemies
        for (let en of this.enemies) this.drawCar(en.x, en.y, en.w, en.h, en.color);
        
        // Draw player
        const flicker = this.player.hitCooldown > 0 && Math.floor(this.player.hitCooldown / 4) % 2 === 0;
        this.drawCar(this.player.x, this.player.y, this.player.w, this.player.h, flicker ? '#ff5252' : '#ffcc00');
        
        // Flash overlay on hit
        if (this.flashTimer > 0) {
            let alpha = Math.max(0, (this.flashTimer / 0.3) * 0.35);
            ctx.fillStyle = `rgba(255,0,0,${alpha})`;
            ctx.fillRect(0, 0, this.width, this.height);
        }
    }
    
    stop() {
    }
};
