// ============================================================================
// ⚖️ 3D Balance Robot — Pseudo-3D Cyberpunk Balancing Game
// RehabDevice IoT | MPU6050
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['balance3d'] = class Balance3DGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        this.calibMin = -30;
        this.calibMax = 30;

        this.score = 0;
        this.isGameOver = false;
        this.gameOverTimer = 0;
        
        // Physics
        this.robotAngle = 0;       // Angle of the robot relative to vertical
        this.robotVel = 0;         // Angular velocity
        this.boardAngle = 0;       // Controlled by player
        this.windForce = 0;
        this.windTimer = 0;
        
        // Difficulty
        this.difficulty = 1.0;
        this.timeAlive = 0;

        // Visuals
        this.time = 0;
        this.particles = [];
        this.cameraShake = 0;
    }

    init(calibMin, calibMax) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        
        this.score = 0;
        this.timeAlive = 0;
        this.isGameOver = false;
        this.robotAngle = 0;
        this.robotVel = 0;
        this.windForce = 0;
        this.difficulty = 1.0;
        this.particles = [];
        this.cameraShake = 0;
        
        this.api.updateHUD("hudScore", "⏱️ 0.0с");
        this.api.updateHUD("hudBotState", "🟢 Балансуй!");
    }

    resize(w, h) {
        this.width = w;
        this.height = h;
    }

    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;
        this.time += dt;

        // Calibration bounds update
        let bc = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; bc = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; bc = true; }
        if (bc) this.api.updateCalibration(this.calibMin, this.calibMax);

        // Map sensor angle to board tilt (-30 to +30 degrees)
        let range = this.calibMax - this.calibMin;
        let norm = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        norm = Math.max(0, Math.min(1, norm));
        let targetBoardAngle = (norm - 0.5) * 60; // Max tilt 30 deg left/right
        
        // Smooth board movement
        this.boardAngle += (targetBoardAngle - this.boardAngle) * 10 * dt;

        if (this.isGameOver) {
            this.gameOverTimer -= dt;
            this.robotAngle += this.robotVel * dt; // continue falling
            this.cameraShake *= Math.pow(0.01, dt);
            
            if (this.gameOverTimer <= 0) {
                this.init(this.calibMin, this.calibMax);
            }
            return;
        }

        this.timeAlive += dt;
        this.score = this.timeAlive;
        this.difficulty = 1.0 + this.timeAlive * 0.02;

        // Wind/Random instability
        this.windTimer -= dt;
        if (this.windTimer <= 0) {
            this.windForce = (Math.random() - 0.5) * 40 * this.difficulty;
            this.windTimer = 1.5 + Math.random() * 2.0;
        }

        // Physics: Robot inverted pendulum
        // Gravity pulls robot further down if it's tilted
        let gravityForce = this.robotAngle * 8.0; 
        
        // Board tilt counteracts gravity
        let boardForce = -this.boardAngle * 9.0;
        
        let angularAccel = gravityForce + boardForce + this.windForce;
        
        this.robotVel += angularAccel * dt;
        this.robotVel *= Math.pow(0.5, dt); // Damping (friction)
        this.robotAngle += this.robotVel * dt;

        // Particles from wheel if struggling
        if (Math.abs(this.boardAngle - this.robotAngle) > 20 && Math.random() < 0.3) {
            this.particles.push({
                x: (Math.random() - 0.5) * 50,
                y: -10,
                vx: (Math.random() - 0.5) * 100,
                vy: -Math.random() * 150 - 50,
                life: 0.5 + Math.random() * 0.5,
                color: '#00f2fe'
            });
        }

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 400 * dt; // Gravity
            p.life -= dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }

        // Fall condition
        if (Math.abs(this.robotAngle) > 65) {
            this.isGameOver = true;
            this.gameOverTimer = 3.0;
            this.cameraShake = 20;
            this.api.updateHUD("hudBotState", "💥 РОБОТ ВПАВ!");
            this._burstParticles();
        } else {
            this.api.updateHUD("hudScore", `⏱️ ${this.score.toFixed(1)}с`);
            let state = Math.abs(this.robotAngle) < 15 ? "🟢 Ідеально" : (Math.abs(this.robotAngle) < 35 ? "🟡 Тримайся" : "🔴 КРИТИЧНО!");
            this.api.updateHUD("hudBotState", state);
        }
    }

    _burstParticles() {
        for(let i=0; i<40; i++) {
            this.particles.push({
                x: (Math.random() - 0.5) * 100,
                y: -50 - Math.random() * 100,
                vx: (Math.random() - 0.5) * 400,
                vy: (Math.random() - 0.5) * 400 - 100,
                life: 1.0 + Math.random(),
                color: Math.random() > 0.5 ? '#ff1744' : '#ff9100'
            });
        }
    }

    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;

        // Camera Shake
        let cx = W / 2 + (Math.random() - 0.5) * this.cameraShake;
        let cy = H * 0.75 + (Math.random() - 0.5) * this.cameraShake;

        // Background (Synthwave Sky)
        let bgGrad = ctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#09041a');
        bgGrad.addColorStop(0.5, '#1e0a3b');
        bgGrad.addColorStop(1, '#ff0055');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // Cyber Grid (Floor)
        this._drawGrid(ctx, W, H);

        // Transform for World
        ctx.save();
        ctx.translate(cx, cy);

        // Draw Base Pillar
        this._drawBasePillar(ctx);

        // Transform for Board
        ctx.save();
        ctx.rotate(this.boardAngle * Math.PI / 180);
        
        // Draw Board
        this._drawBoard(ctx);

        // Draw Particles (behind/around robot)
        this._drawParticles(ctx);

        // Draw Robot
        this._drawRobot(ctx);

        ctx.restore(); // Board
        ctx.restore(); // World

        // Game Over Overlay
        if (this.isGameOver) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#ff1744';
            ctx.textAlign = 'center';
            ctx.font = `bold ${Math.min(W*0.08, 60)}px sans-serif`;
            ctx.fillText('ЗБІЙ СИСТЕМИ', W/2, H/2 - 20);
            ctx.fillStyle = '#fff';
            ctx.font = `${Math.min(W*0.04, 30)}px sans-serif`;
            ctx.fillText(`Час: ${this.score.toFixed(1)}с`, W/2, H/2 + 30);
        }
    }

    _drawGrid(ctx, W, H) {
        let horizon = H * 0.45;
        let speed = (this.time * 200) % 100;
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, horizon, W, H - horizon);
        ctx.clip();
        
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.4)';
        ctx.lineWidth = 2;

        // Vertical lines (Perspective)
        for (let i = -10; i <= 10; i++) {
            ctx.beginPath();
            ctx.moveTo(W/2, horizon);
            ctx.lineTo(W/2 + i * 200, H);
            ctx.stroke();
        }

        // Horizontal lines
        for (let y = 0; y < H - horizon; y += 5) {
            let z = (y + speed) / 100;
            if (z < 0.1) continue;
            let py = horizon + (z * z * 15);
            if (py > H) break;
            
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(W, py);
            ctx.globalAlpha = Math.min(1, z * 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawBasePillar(ctx) {
        // Sci-fi glowing base below the board
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.moveTo(-40, 20);
        ctx.lineTo(40, 20);
        ctx.lineTo(60, 200);
        ctx.lineTo(-60, 200);
        ctx.fill();

        ctx.strokeStyle = '#ff0055';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = '#ff0055';
        ctx.globalAlpha = 0.5 + Math.sin(this.time * 5) * 0.2;
        ctx.beginPath();
        ctx.ellipse(0, 30, 35, 10, 0, 0, 6.28);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    _drawBoard(ctx) {
        // A cool high-tech balance board
        let w = 220;
        let h = 25;

        // 3D Side/Thickness
        ctx.fillStyle = '#222';
        ctx.beginPath();
        ctx.moveTo(-w, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w, h);
        ctx.lineTo(-w, h);
        ctx.fill();

        // Top Surface
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.ellipse(0, 0, w, 30, 0, 0, 6.28);
        ctx.fill();
        
        // Neon Rim
        ctx.strokeStyle = '#00f2fe';
        ctx.lineWidth = 4;
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#00f2fe';
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Center Pivot Marker
        ctx.fillStyle = '#ff0055';
        ctx.beginPath();
        ctx.ellipse(0, 0, 20, 8, 0, 0, 6.28);
        ctx.fill();
    }

    _drawRobot(ctx) {
        ctx.save();
        
        // Robot balances and pivots from the center of the board
        ctx.rotate(this.robotAngle * Math.PI / 180);
        
        // --- Wheel ---
        let wheelR = 30;
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.ellipse(0, -wheelR, wheelR, wheelR, 0, 0, 6.28);
        ctx.fill();
        ctx.strokeStyle = '#00f2fe';
        ctx.lineWidth = 4;
        ctx.stroke();
        
        // Wheel spokes rotating
        ctx.save();
        ctx.translate(0, -wheelR);
        let wheelSpin = (this.boardAngle - this.robotAngle) * 0.1; 
        ctx.rotate(wheelSpin);
        ctx.beginPath(); ctx.moveTo(-wheelR, 0); ctx.lineTo(wheelR, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -wheelR); ctx.lineTo(0, wheelR); ctx.stroke();
        ctx.restore();

        // --- Body Suspension ---
        ctx.fillStyle = '#555';
        ctx.fillRect(-8, -100, 16, 40);

        // --- Main Torso (3D Box effect) ---
        let th = 80;
        let tw = 60;
        let ty = -180;
        
        // Side/Shadow
        ctx.fillStyle = '#222';
        ctx.fillRect(-tw/2 + 10, ty + 10, tw, th);
        
        // Front
        ctx.fillStyle = '#e0e0e0';
        ctx.fillRect(-tw/2, ty, tw, th);
        
        // Torso Details
        ctx.fillStyle = '#ff0055';
        ctx.fillRect(-tw/2 + 15, ty + 20, 30, 10);
        ctx.fillStyle = '#00f2fe';
        ctx.fillRect(-tw/2 + 15, ty + 40, 30, 10);

        // --- Head ---
        let hSize = 50;
        let hy = -220;
        ctx.fillStyle = '#ddd';
        ctx.beginPath();
        ctx.roundRect(-hSize/2, hy, hSize, hSize*0.8, 10);
        ctx.fill();

        // Eye (Visor)
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.roundRect(-hSize/2 + 5, hy + 10, hSize - 10, 15, 5);
        ctx.fill();

        // Glowing Eye Node
        let lookX = (this.robotAngle / 60) * 10; // Eye shifts left/right
        ctx.fillStyle = this.isGameOver ? '#ff1744' : '#00f2fe';
        ctx.shadowBlur = 10;
        ctx.shadowColor = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(lookX, hy + 17, 4, 0, 6.28);
        ctx.fill();
        ctx.shadowBlur = 0;

        // --- Arms ---
        // Arms swing wildly to simulate balancing
        let armSwing = (this.robotVel * 0.5) * Math.PI / 180;
        if (this.isGameOver) armSwing = Math.PI * 0.8; // Arms up in panic

        // Left Arm
        ctx.save();
        ctx.translate(-tw/2 - 5, ty + 15);
        ctx.rotate(-Math.PI/6 - armSwing);
        this._drawArm(ctx);
        ctx.restore();

        // Right Arm
        ctx.save();
        ctx.translate(tw/2 + 5, ty + 15);
        ctx.rotate(Math.PI/6 - armSwing); // Opposite swing
        this._drawArm(ctx);
        ctx.restore();

        ctx.restore();
    }

    _drawArm(ctx) {
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.roundRect(-10, -10, 20, 70, 10);
        ctx.fill();
        
        // Claw
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(0, 60, 15, 0, Math.PI, false);
        ctx.fill();
    }

    _drawParticles(ctx) {
        for (let p of this.particles) {
            ctx.globalAlpha = Math.min(1, p.life);
            ctx.fillStyle = p.color;
            ctx.shadowBlur = 10;
            ctx.shadowColor = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, 6.28);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }

    stop() {
        this.particles = [];
    }
};
