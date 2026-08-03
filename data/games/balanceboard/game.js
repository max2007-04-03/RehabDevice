// ============================================================================
// ⚖️ BalanceBoard — Гра на баланс для реабілітації кисті
// RehabDevice IoT System | MPU6050/MPU6500 Sensor Control
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['balanceboard'] = class BalanceBoardGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;

        // Calibration & difficulty
        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = 'auto';

        // Canvas dimensions
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        // Game state
        this.isActive = false;
        this.gameOver = false;
        this.survivalTime = 0;
        this.bestTime = 0;
        this.roundNumber = 0;

        // Platform physics
        this.externalForceAngle = 0;   // The wave/wind force tilting the platform (degrees)
        this.effectiveAngle = 0;        // externalForce - playerCompensation
        this.platformVisualAngle = 0;   // Smoothed visual angle for rendering
        this.FALL_THRESHOLD = 38;       // Degrees at which character falls

        // Wave force generator state
        this.waveTime = 0;
        this.waveAmplitude = 8;
        this.waveFrequency = 0.4;
        this.gustTimer = 0;
        this.gustForce = 0;
        this.gustDuration = 0;
        this.currentGustTime = 0;
        this.difficultyLevel = 1;       // Increases over time (1-10)

        // Character state
        this.charX = 0;
        this.charY = 0;
        this.charSlide = 0;             // Character sliding on platform
        this.charArmAngle = 0;          // Arms balancing animation
        this.charBodyTilt = 0;          // Body lean
        this.charSquish = 1;            // Squash-stretch for landing/falling
        this.charEyeScale = 1;          // Eye expression (fear)
        this.charFalling = false;
        this.charFallVelocity = 0;
        this.charFallRotation = 0;
        this.charBlink = 0;
        this.charBlinkTimer = 0;

        // Particles
        this.particles = [];
        this.sparkTimer = 0;

        // Starfield background
        this.stars = [];
        this.auroraPhase = 0;

        // Danger indicator
        this.dangerLevel = 0;           // 0-1 mapped from effective angle
        this.dangerPulse = 0;

        // Combo system
        this.comboMultiplier = 1;
        this.steadyTimer = 0;           // Time holding angle < 10°

        // Screen shake
        this.shakeX = 0;
        this.shakeY = 0;
        this.shakeIntensity = 0;

        // Post-fall animation
        this.postFallTimer = 0;
        this.POST_FALL_DURATION = 2.5;
    }

    init(calibMin, calibMax, difficulty) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.difficulty = difficulty || 'auto';

        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        this._initStars();
        this._resetRound();
        this.updateHUD();
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
    }

    // ========================================================================
    // GAME RESET
    // ========================================================================
    _resetRound() {
        this.isActive = true;
        this.gameOver = false;
        this.survivalTime = 0;
        this.roundNumber++;
        this.externalForceAngle = 0;
        this.effectiveAngle = 0;
        this.platformVisualAngle = 0;
        this.waveTime = 0;
        this.gustTimer = 3 + Math.random() * 5;
        this.gustForce = 0;
        this.difficultyLevel = 1;
        this.charSlide = 0;
        this.charFalling = false;
        this.charFallVelocity = 0;
        this.charFallRotation = 0;
        this.charSquish = 1;
        this.charEyeScale = 1;
        this.comboMultiplier = 1;
        this.steadyTimer = 0;
        this.particles = [];
        this.shakeIntensity = 0;
        this.postFallTimer = 0;
        this.dangerLevel = 0;

        this._setDifficultyParams();
    }

    _setDifficultyParams() {
        switch (this.difficulty) {
            case 'easy':
                this.waveAmplitude = 10;
                this.waveFrequency = 0.4;
                this.FALL_THRESHOLD = 35;
                break;
            case 'medium':
                this.waveAmplitude = 18;
                this.waveFrequency = 0.6;
                this.FALL_THRESHOLD = 28;
                break;
            case 'hard':
                this.waveAmplitude = 30;
                this.waveFrequency = 0.85;
                this.FALL_THRESHOLD = 22;
                break;
            case 'auto':
            default:
                this.waveAmplitude = 10;
                this.waveFrequency = 0.4;
                this.FALL_THRESHOLD = 32;
                break;
        }
    }

    // ========================================================================
    // STARFIELD INIT
    // ========================================================================
    _initStars() {
        this.stars = [];
        for (let i = 0; i < 120; i++) {
            this.stars.push({
                x: Math.random(),
                y: Math.random() * 0.7,
                size: 0.5 + Math.random() * 2,
                brightness: 0.3 + Math.random() * 0.7,
                twinkleSpeed: 0.5 + Math.random() * 3,
                twinklePhase: Math.random() * Math.PI * 2
            });
        }
    }

    // ========================================================================
    // MAIN UPDATE
    // ========================================================================
    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;

        // Dynamic calibration expansion (same as pingpong)
        let boundsChanged = false;
        if (currentAngle > this.calibMax) {
            this.calibMax += (currentAngle - this.calibMax) * 0.05;
            boundsChanged = true;
        }
        if (currentAngle < this.calibMin) {
            this.calibMin -= (this.calibMin - currentAngle) * 0.05;
            boundsChanged = true;
        }
        if (boundsChanged) this.api.updateCalibration(this.calibMin, this.calibMax);

        // Map sensor angle to compensation angle
        let range = this.calibMax - this.calibMin;
        let normalized = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        normalized = Math.max(0, Math.min(1, normalized));
        // Map to ±maxCompensation degrees — center = 0
        let maxCompensation = Math.max(Math.abs(this.calibMin), Math.abs(this.calibMax));
        let playerCompensation = (normalized - 0.5) * 2 * maxCompensation;

        // Aurora animation
        this.auroraPhase += dt * 0.3;

        // Character blink
        this.charBlinkTimer -= dt;
        if (this.charBlinkTimer <= 0) {
            this.charBlink = 1;
            this.charBlinkTimer = 2 + Math.random() * 4;
        }
        if (this.charBlink > 0) {
            this.charBlink -= dt * 8;
            if (this.charBlink < 0) this.charBlink = 0;
        }

        // Screen shake decay
        this.shakeIntensity *= Math.pow(0.05, dt);
        if (this.shakeIntensity < 0.3) this.shakeIntensity = 0;
        this.shakeX = (Math.random() - 0.5) * this.shakeIntensity;
        this.shakeY = (Math.random() - 0.5) * this.shakeIntensity;

        // Update particles
        this._updateParticles(dt);

        // ===== POST-FALL (waiting for restart) =====
        if (this.gameOver) {
            this.postFallTimer += dt;
            // Continue fall animation
            if (this.charFalling) {
                this.charFallVelocity += 800 * dt;
                this.charY += this.charFallVelocity * dt;
                this.charFallRotation += 5 * dt;
                if (this.charY > this.height + 100) {
                    this.charFalling = false;
                }
            }
            // Auto-restart after delay
            if (this.postFallTimer > this.POST_FALL_DURATION) {
                this._resetRound();
            }
            return;
        }

        // ===== ACTIVE GAME LOGIC =====
        this.survivalTime += dt;

        // Increase difficulty over time
        if (this.difficulty === 'auto') {
            this.difficultyLevel = Math.min(10, 1 + this.survivalTime / 10);
            this.waveAmplitude = 10 + (this.difficultyLevel - 1) * 3.5;
            this.waveFrequency = 0.4 + (this.difficultyLevel - 1) * 0.08;
            this.FALL_THRESHOLD = Math.max(22, 32 - (this.difficultyLevel - 1) * 1.1);
        } else {
            this.difficultyLevel = Math.min(10, 1 + this.survivalTime / 20);
            let ampBoost = (this.difficultyLevel - 1) * 1.5;
            let freqBoost = (this.difficultyLevel - 1) * 0.03;
            switch (this.difficulty) {
                case 'easy':
                    this.waveAmplitude = 8 + ampBoost * 0.5;
                    this.waveFrequency = 0.3 + freqBoost * 0.5;
                    break;
                case 'medium':
                    this.waveAmplitude = 15 + ampBoost;
                    this.waveFrequency = 0.5 + freqBoost;
                    break;
                case 'hard':
                    this.waveAmplitude = 25 + ampBoost * 1.5;
                    this.waveFrequency = 0.7 + freqBoost * 1.5;
                    break;
            }
        }

        // Generate wave force
        this.waveTime += dt;
        let wave1 = Math.sin(this.waveTime * this.waveFrequency * Math.PI * 2) * this.waveAmplitude;
        let wave2 = Math.sin(this.waveTime * this.waveFrequency * 1.7 * Math.PI * 2) * this.waveAmplitude * 0.3;
        let wave3 = Math.sin(this.waveTime * this.waveFrequency * 0.4 * Math.PI * 2) * this.waveAmplitude * 0.5;
        this.externalForceAngle = wave1 + wave2 + wave3;

        // Gusts (sudden wind bursts)
        this.gustTimer -= dt;
        if (this.gustTimer <= 0) {
            let gustChance = this.difficulty === 'easy' ? 0.15 :
                             this.difficulty === 'hard' ? 0.8 : 0.5;
            if (this.difficulty === 'auto') gustChance = Math.min(0.7, 0.1 + this.difficultyLevel * 0.06);

            if (Math.random() < gustChance) {
                this.gustForce = (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 15 * (this.difficultyLevel / 5));
                this.gustDuration = 0.5 + Math.random() * 1.2;
                this.currentGustTime = 0;
            }
            this.gustTimer = 2 + Math.random() * 4;
        }

        // Apply gust
        if (this.gustDuration > 0) {
            this.currentGustTime += dt;
            let gustProgress = this.currentGustTime / this.gustDuration;
            let gustEnvelope = Math.sin(gustProgress * Math.PI); // Smooth rise and fall
            this.externalForceAngle += this.gustForce * gustEnvelope;
            if (this.currentGustTime >= this.gustDuration) {
                this.gustDuration = 0;
                this.gustForce = 0;
            }
        }

        // Calculate effective angle (external force minus player compensation)
        this.effectiveAngle = this.externalForceAngle - playerCompensation;

        // Smooth visual platform angle
        this.platformVisualAngle += (this.effectiveAngle - this.platformVisualAngle) * 8 * dt;

        // Danger level (0-1)
        this.dangerLevel = Math.min(1, Math.abs(this.effectiveAngle) / this.FALL_THRESHOLD);
        this.dangerPulse += dt * (3 + this.dangerLevel * 8);

        // Character slide along platform based on tilt
        let slideForce = Math.sin(this.platformVisualAngle * Math.PI / 180) * 600; // Increased slide physics
        this.charSlide += slideForce * dt;
        this.charSlide *= Math.pow(0.5, dt); // Reduced friction for more sliding
        this.charSlide = Math.max(-this.width * 0.25, Math.min(this.width * 0.25, this.charSlide));

        // Character body tilt (reacts to angle)
        let targetBodyTilt = this.effectiveAngle * 0.5;
        this.charBodyTilt += (targetBodyTilt - this.charBodyTilt) * 5 * dt;

        // Arm balancing animation (arms move opposite to tilt)
        let targetArmAngle = -this.effectiveAngle * 1.5;
        this.charArmAngle += (targetArmAngle - this.charArmAngle) * 6 * dt;

        // Eye scale (fear when danger is high)
        let targetEyeScale = 1 + this.dangerLevel * 0.8;
        this.charEyeScale += (targetEyeScale - this.charEyeScale) * 4 * dt;

        // Squish (wobble when unstable)
        let targetSquish = 1 - this.dangerLevel * 0.15;
        this.charSquish += (targetSquish - this.charSquish) * 6 * dt;

        // Steady combo (angle < 10° = steady)
        if (Math.abs(this.effectiveAngle) < 10) {
            this.steadyTimer += dt;
            if (this.steadyTimer > 3) {
                this.comboMultiplier = Math.min(5, 1 + Math.floor(this.steadyTimer / 3));
            }
        } else {
            this.steadyTimer = Math.max(0, this.steadyTimer - dt * 2);
            this.comboMultiplier = Math.max(1, this.comboMultiplier - dt);
        }

        // Balance sparks (when holding steady)
        this.sparkTimer -= dt;
        if (Math.abs(this.effectiveAngle) < 8 && this.sparkTimer <= 0) {
            this._spawnBalanceSparks();
            this.sparkTimer = 0.3;
        }

        // Danger shake
        if (this.dangerLevel > 0.7) {
            this.shakeIntensity = Math.max(this.shakeIntensity, this.dangerLevel * 4);
        }

        // ===== FALL CHECK =====
        if (Math.abs(this.effectiveAngle) >= this.FALL_THRESHOLD) {
            this._triggerFall();
        }

        this.updateHUD();
    }

    // ========================================================================
    // FALL
    // ========================================================================
    _triggerFall() {
        this.gameOver = true;
        this.isActive = false;
        this.charFalling = true;
        this.charFallVelocity = -200;
        this.charFallRotation = 0;
        this.postFallTimer = 0;

        if (this.survivalTime > this.bestTime) {
            this.bestTime = this.survivalTime;
        }

        // Shake effect
        this.shakeIntensity = 12;

        // Spawn explosion particles
        let cx = this.width / 2 + this.charSlide;
        let cy = this.height * 0.42;
        for (let i = 0; i < 30; i++) {
            let angle = Math.random() * Math.PI * 2;
            let speed = 80 + Math.random() * 200;
            this.particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 100,
                life: 1,
                maxLife: 1,
                size: 3 + Math.random() * 5,
                color: Math.random() > 0.5 ? '#ff1744' : '#ff9100',
                gravity: 300,
                type: 'explosion'
            });
        }

        // Notify HUD
        this.api.updateHUD("hudBotState", `💥 Падіння! Рекорд: ${this.bestTime.toFixed(1)}с`);
    }

    // ========================================================================
    // PARTICLES
    // ========================================================================
    _spawnBalanceSparks() {
        let cx = this.width / 2 + this.charSlide;
        let cy = this.height * 0.45;
        for (let i = 0; i < 3; i++) {
            this.particles.push({
                x: cx + (Math.random() - 0.5) * 40,
                y: cy + (Math.random() - 0.5) * 20,
                vx: (Math.random() - 0.5) * 60,
                vy: -30 - Math.random() * 60,
                life: 1,
                maxLife: 1,
                size: 1.5 + Math.random() * 2.5,
                color: this.comboMultiplier >= 3 ? '#00f2fe' : '#00e676',
                gravity: -20,
                type: 'spark'
            });
        }
    }

    _updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += (p.gravity || 0) * dt;
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }

    // ========================================================================
    // HUD
    // ========================================================================
    updateHUD() {
        let minutes = Math.floor(this.survivalTime / 60);
        let seconds = Math.floor(this.survivalTime % 60);
        let timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        let comboStr = this.comboMultiplier > 1 ? ` (x${Math.floor(this.comboMultiplier)})` : '';
        this.api.updateHUD("hudScore", `⏱ Утримання: ${timeStr}${comboStr}`);

        if (!this.gameOver) {
            let levelIcon = this.difficultyLevel < 3 ? '🌊' :
                            this.difficultyLevel < 6 ? '🌊🌊' : '🌊🌊🌊';
            this.api.updateHUD("hudBotState", `${levelIcon} Хвиля: ${Math.floor(this.difficultyLevel)}/10`);
        }
    }

    // ========================================================================
    // MAIN DRAW
    // ========================================================================
    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;

        ctx.save();
        ctx.translate(this.shakeX, this.shakeY);

        // === BACKGROUND ===
        this._drawBackground(ctx, W, H);

        // === AURORA ===
        this._drawAurora(ctx, W, H);

        // === GROUND / MOUNTAIN SILHOUETTE ===
        this._drawMountains(ctx, W, H);

        // === FULCRUM (triangle support) ===
        this._drawFulcrum(ctx, W, H);

        // === PLATFORM ===
        this._drawPlatform(ctx, W, H);

        // === CHARACTER ===
        if (!this.charFalling || this.charY < H + 100) {
            this._drawCharacter(ctx, W, H);
        }

        // === PARTICLES ===
        this._drawParticles(ctx);

        // === DANGER INDICATOR (edge vignette) ===
        this._drawDangerVignette(ctx, W, H);

        // === GAME OVER OVERLAY ===
        if (this.gameOver && !this.charFalling) {
            this._drawGameOverOverlay(ctx, W, H);
        }

        ctx.restore();
    }

    // ========================================================================
    // BACKGROUND RENDERING
    // ========================================================================
    _drawBackground(ctx, W, H) {
        // Night sky gradient
        let grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#050a18');
        grad.addColorStop(0.3, '#0a1628');
        grad.addColorStop(0.6, '#0f1f3a');
        grad.addColorStop(1, '#1a2744');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Stars
        let time = performance.now() / 1000;
        for (let s of this.stars) {
            let twinkle = 0.5 + 0.5 * Math.sin(time * s.twinkleSpeed + s.twinklePhase);
            let alpha = s.brightness * twinkle;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(s.x * W, s.y * H, s.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawAurora(ctx, W, H) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.globalCompositeOperation = 'screen';

        for (let i = 0; i < 3; i++) {
            let auroraGrad = ctx.createLinearGradient(0, H * 0.05, 0, H * 0.35);
            let hue = 140 + i * 40 + Math.sin(this.auroraPhase + i) * 20;
            auroraGrad.addColorStop(0, `hsla(${hue}, 80%, 60%, 0)`);
            auroraGrad.addColorStop(0.5, `hsla(${hue}, 80%, 60%, 0.6)`);
            auroraGrad.addColorStop(1, `hsla(${hue}, 80%, 60%, 0)`);

            ctx.beginPath();
            ctx.moveTo(0, H * 0.1);
            for (let x = 0; x <= W; x += 20) {
                let y = H * 0.15 + Math.sin(x / W * 4 + this.auroraPhase * (1 + i * 0.3)) * H * 0.06
                      + Math.sin(x / W * 7 + this.auroraPhase * 0.7) * H * 0.03;
                ctx.lineTo(x, y + i * H * 0.04);
            }
            ctx.lineTo(W, H * 0.35);
            ctx.lineTo(0, H * 0.35);
            ctx.closePath();
            ctx.fillStyle = auroraGrad;
            ctx.fill();
        }

        ctx.restore();
    }

    _drawMountains(ctx, W, H) {
        // Mountain silhouette
        ctx.fillStyle = '#0d1520';
        ctx.beginPath();
        ctx.moveTo(0, H * 0.7);
        ctx.lineTo(W * 0.1, H * 0.55);
        ctx.lineTo(W * 0.2, H * 0.6);
        ctx.lineTo(W * 0.35, H * 0.45);
        ctx.lineTo(W * 0.45, H * 0.52);
        ctx.lineTo(W * 0.55, H * 0.42);
        ctx.lineTo(W * 0.65, H * 0.5);
        ctx.lineTo(W * 0.75, H * 0.38);
        ctx.lineTo(W * 0.85, H * 0.48);
        ctx.lineTo(W * 0.95, H * 0.44);
        ctx.lineTo(W, H * 0.55);
        ctx.lineTo(W, H);
        ctx.lineTo(0, H);
        ctx.closePath();
        ctx.fill();

        // Snow caps glow
        ctx.strokeStyle = 'rgba(200, 220, 255, 0.08)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(W * 0.35, H * 0.45);
        ctx.lineTo(W * 0.55, H * 0.42);
        ctx.lineTo(W * 0.75, H * 0.38);
        ctx.stroke();
    }

    // ========================================================================
    // FULCRUM & PLATFORM
    // ========================================================================
    _drawFulcrum(ctx, W, H) {
        let cx = W / 2;
        let baseY = H * 0.72;
        let triH = H * 0.08;
        let triW = W * 0.06;

        // Fulcrum triangle (stone/metal)
        let fulcrumGrad = ctx.createLinearGradient(cx, baseY - triH, cx, baseY);
        fulcrumGrad.addColorStop(0, '#4a5568');
        fulcrumGrad.addColorStop(1, '#2d3748');

        ctx.fillStyle = fulcrumGrad;
        ctx.beginPath();
        ctx.moveTo(cx, baseY - triH);
        ctx.lineTo(cx - triW, baseY);
        ctx.lineTo(cx + triW, baseY);
        ctx.closePath();
        ctx.fill();

        // Edge highlight
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - triW + 2, baseY);
        ctx.lineTo(cx, baseY - triH + 2);
        ctx.lineTo(cx + triW - 2, baseY);
        ctx.stroke();
    }

    _drawPlatform(ctx, W, H) {
        let cx = W / 2;
        let pivotY = H * 0.64;
        let platW = W * 0.55;
        let platH = H * 0.028;
        let angleRad = this.platformVisualAngle * Math.PI / 180;

        ctx.save();
        ctx.translate(cx, pivotY);
        ctx.rotate(angleRad);

        // Platform shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(-platW / 2, platH * 0.5, platW, platH * 0.8);

        // Main platform body (wood texture gradient)
        let platGrad = ctx.createLinearGradient(-platW / 2, -platH, platW / 2, platH);
        platGrad.addColorStop(0, '#5D4037');
        platGrad.addColorStop(0.3, '#795548');
        platGrad.addColorStop(0.5, '#8D6E63');
        platGrad.addColorStop(0.7, '#795548');
        platGrad.addColorStop(1, '#5D4037');

        ctx.fillStyle = platGrad;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-platW / 2, -platH / 2, platW, platH, 4);
            ctx.fill();
        } else {
            ctx.fillRect(-platW / 2, -platH / 2, platW, platH);
        }

        // Top highlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(-platW / 2 + 4, -platH / 2, platW - 8, platH * 0.3);

        // Wood grain lines
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 8; i++) {
            let x = -platW / 2 + (platW / 8) * i + platW / 16;
            ctx.beginPath();
            ctx.moveTo(x, -platH / 2 + 2);
            ctx.lineTo(x, platH / 2 - 2);
            ctx.stroke();
        }

        // End caps (metal)
        ctx.fillStyle = '#90A4AE';
        ctx.fillRect(-platW / 2, -platH / 2 - 1, 6, platH + 2);
        ctx.fillRect(platW / 2 - 6, -platH / 2 - 1, 6, platH + 2);

        // Danger color edge glow
        if (this.dangerLevel > 0.3) {
            let glowAlpha = (this.dangerLevel - 0.3) * 1.4;
            let pulse = 0.6 + 0.4 * Math.sin(this.dangerPulse);
            ctx.shadowBlur = 15 * this.dangerLevel;
            ctx.shadowColor = this.dangerLevel > 0.7 ?
                `rgba(255, 23, 68, ${glowAlpha * pulse})` :
                `rgba(255, 145, 0, ${glowAlpha * pulse * 0.7})`;
            ctx.strokeStyle = this.dangerLevel > 0.7 ?
                `rgba(255, 23, 68, ${glowAlpha * 0.6})` :
                `rgba(255, 145, 0, ${glowAlpha * 0.4})`;
            ctx.lineWidth = 2;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(-platW / 2, -platH / 2, platW, platH, 4);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    // ========================================================================
    // CHARACTER (Robot)
    // ========================================================================
    _drawCharacter(ctx, W, H) {
        let cx = W / 2 + this.charSlide;
        let pivotY = H * 0.64;
        let angleRad = this.platformVisualAngle * Math.PI / 180;

        // Position character on the tilted platform
        let platOffsetX = this.charSlide;
        let charBaseX = cx;
        let charBaseY = pivotY - H * 0.028 / 2;

        // Adjust for platform tilt
        charBaseX += Math.sin(angleRad) * 0; // Already sliding
        charBaseY -= Math.cos(angleRad) * H * 0.005;

        if (this.charFalling) {
            charBaseY = this.charY;
        }

        ctx.save();
        ctx.translate(charBaseX, charBaseY);

        if (this.charFalling) {
            ctx.rotate(this.charFallRotation);
        } else {
            ctx.rotate(this.charBodyTilt * Math.PI / 180 * 0.3);
        }

        ctx.scale(1, this.charSquish);

        let scale = Math.min(W, H) / 500;
        if (scale < 0.5) scale = 0.5;
        if (scale > 2) scale = 2;

        // ---- LEGS ----
        let legSpread = 12 * scale;
        let legH = 22 * scale;
        let legW = 7 * scale;

        // Left leg
        ctx.fillStyle = '#37474F';
        ctx.fillRect(-legSpread - legW / 2, -legH, legW, legH);
        // Right leg
        ctx.fillRect(legSpread - legW / 2, -legH, legW, legH);

        // Feet (rounded)
        ctx.fillStyle = '#546E7A';
        ctx.fillRect(-legSpread - legW / 2 - 2 * scale, -2 * scale, legW + 4 * scale, 4 * scale);
        ctx.fillRect(legSpread - legW / 2 - 2 * scale, -2 * scale, legW + 4 * scale, 4 * scale);

        // ---- BODY ----
        let bodyW = 32 * scale;
        let bodyH = 36 * scale;
        let bodyY = -legH;

        let bodyGrad = ctx.createLinearGradient(0, bodyY - bodyH, 0, bodyY);
        bodyGrad.addColorStop(0, '#1565C0');
        bodyGrad.addColorStop(0.5, '#1976D2');
        bodyGrad.addColorStop(1, '#1565C0');
        ctx.fillStyle = bodyGrad;

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-bodyW / 2, bodyY - bodyH, bodyW, bodyH, 6 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-bodyW / 2, bodyY - bodyH, bodyW, bodyH);
        }

        // Chest panel (glowing indicator)
        let chestGlow = this.dangerLevel > 0.6 ?
            `rgba(255, 23, 68, ${0.6 + 0.4 * Math.sin(this.dangerPulse)})` :
            `rgba(0, 230, 118, ${0.5 + 0.3 * Math.sin(performance.now() / 500)})`;
        ctx.fillStyle = chestGlow;
        ctx.beginPath();
        ctx.arc(0, bodyY - bodyH * 0.55, 5 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 10 * scale;
        ctx.shadowColor = chestGlow;
        ctx.fill();
        ctx.shadowBlur = 0;

        // ---- ARMS (balancing) ----
        let armLen = 28 * scale;
        let armW = 6 * scale;
        let shoulderY = bodyY - bodyH * 0.85;
        let armAngleRad = this.charArmAngle * Math.PI / 180;

        // Left arm
        ctx.save();
        ctx.translate(-bodyW / 2, shoulderY);
        ctx.rotate(-0.4 + armAngleRad * 0.5);
        ctx.fillStyle = '#1976D2';
        ctx.fillRect(-armLen, -armW / 2, armLen, armW);
        // Hand
        ctx.fillStyle = '#90A4AE';
        ctx.beginPath();
        ctx.arc(-armLen, 0, armW * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Right arm
        ctx.save();
        ctx.translate(bodyW / 2, shoulderY);
        ctx.rotate(0.4 - armAngleRad * 0.5);
        ctx.fillStyle = '#1976D2';
        ctx.fillRect(0, -armW / 2, armLen, armW);
        // Hand
        ctx.fillStyle = '#90A4AE';
        ctx.beginPath();
        ctx.arc(armLen, 0, armW * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // ---- HEAD ----
        let headW = 26 * scale;
        let headH = 24 * scale;
        let headY = bodyY - bodyH;

        // Neck
        ctx.fillStyle = '#546E7A';
        ctx.fillRect(-4 * scale, headY - 3 * scale, 8 * scale, 6 * scale);

        // Head (helmet)
        let headGrad = ctx.createLinearGradient(0, headY - headH, 0, headY);
        headGrad.addColorStop(0, '#78909C');
        headGrad.addColorStop(1, '#546E7A');
        ctx.fillStyle = headGrad;

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-headW / 2, headY - headH, headW, headH, 8 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-headW / 2, headY - headH, headW, headH);
        }

        // Visor (face)
        let visorW = headW * 0.75;
        let visorH = headH * 0.55;
        let visorY = headY - headH * 0.7;
        ctx.fillStyle = '#0a1628';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-visorW / 2, visorY, visorW, visorH, 4 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-visorW / 2, visorY, visorW, visorH);
        }

        // Eyes
        let eyeSize = 3.5 * scale * this.charEyeScale;
        let blinkSquish = 1 - this.charBlink * 0.9;
        let eyeY = visorY + visorH * 0.45;

        ctx.fillStyle = '#00f2fe';
        ctx.save();
        // Left eye
        ctx.translate(-6 * scale, eyeY);
        ctx.scale(1, blinkSquish);
        ctx.beginPath();
        ctx.arc(0, 0, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        // Right eye
        ctx.translate(6 * scale, eyeY);
        ctx.scale(1, blinkSquish);
        ctx.fillStyle = '#00f2fe';
        ctx.beginPath();
        ctx.arc(0, 0, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Eye glow
        ctx.shadowBlur = 8 * scale;
        ctx.shadowColor = '#00f2fe';
        ctx.fillStyle = 'rgba(0, 242, 254, 0.3)';
        ctx.beginPath();
        ctx.arc(-6 * scale, eyeY, eyeSize * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(6 * scale, eyeY, eyeSize * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Antenna
        ctx.strokeStyle = '#90A4AE';
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.moveTo(0, headY - headH);
        ctx.lineTo(0, headY - headH - 8 * scale);
        ctx.stroke();
        // Antenna tip (blinking)
        let antennaGlow = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        ctx.fillStyle = `rgba(0, 242, 254, ${antennaGlow})`;
        ctx.beginPath();
        ctx.arc(0, headY - headH - 10 * scale, 2.5 * scale, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    // ========================================================================
    // PARTICLES RENDERING
    // ========================================================================
    _drawParticles(ctx) {
        for (let p of this.particles) {
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;

            if (p.type === 'spark') {
                // Glow sparks
                ctx.shadowBlur = 6;
                ctx.shadowColor = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            } else {
                // Explosion pieces
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (0.3 + p.life * 0.7), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    // ========================================================================
    // DANGER VIGNETTE
    // ========================================================================
    _drawDangerVignette(ctx, W, H) {
        if (this.dangerLevel < 0.3) return;

        let alpha = (this.dangerLevel - 0.3) * 0.5;
        let pulse = 0.7 + 0.3 * Math.sin(this.dangerPulse);
        alpha *= pulse;

        let color = this.dangerLevel > 0.7 ? `rgba(255, 23, 68, ${alpha})` : `rgba(255, 145, 0, ${alpha * 0.6})`;

        // Top/bottom vignette
        let vGrad = ctx.createLinearGradient(0, 0, 0, H * 0.15);
        vGrad.addColorStop(0, color);
        vGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = vGrad;
        ctx.fillRect(0, 0, W, H * 0.15);

        let vGrad2 = ctx.createLinearGradient(0, H * 0.85, 0, H);
        vGrad2.addColorStop(0, 'rgba(0,0,0,0)');
        vGrad2.addColorStop(1, color);
        ctx.fillStyle = vGrad2;
        ctx.fillRect(0, H * 0.85, W, H * 0.15);

        // Left/right vignette
        let hGrad = ctx.createLinearGradient(0, 0, W * 0.08, 0);
        hGrad.addColorStop(0, color);
        hGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hGrad;
        ctx.fillRect(0, 0, W * 0.08, H);

        let hGrad2 = ctx.createLinearGradient(W * 0.92, 0, W, 0);
        hGrad2.addColorStop(0, 'rgba(0,0,0,0)');
        hGrad2.addColorStop(1, color);
        ctx.fillStyle = hGrad2;
        ctx.fillRect(W * 0.92, 0, W * 0.08, H);
    }

    // ========================================================================
    // GAME OVER OVERLAY
    // ========================================================================
    _drawGameOverOverlay(ctx, W, H) {
        // Semi-transparent background
        ctx.fillStyle = 'rgba(10, 14, 23, 0.7)';
        ctx.fillRect(0, 0, W, H);

        // Title
        let titleSize = Math.min(48, W * 0.08);
        ctx.font = `bold ${titleSize}px 'Inter', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Glow
        ctx.shadowBlur = 20;
        ctx.shadowColor = '#ff1744';
        ctx.fillStyle = '#ff1744';
        ctx.fillText('💥 Падіння!', W / 2, H * 0.35);
        ctx.shadowBlur = 0;

        // Score
        let scoreSize = Math.min(28, W * 0.05);
        ctx.font = `600 ${scoreSize}px 'Inter', sans-serif`;
        ctx.fillStyle = '#ffffff';
        let minutes = Math.floor(this.survivalTime / 60);
        let seconds = Math.floor(this.survivalTime % 60);
        ctx.fillText(`⏱ Час: ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`, W / 2, H * 0.45);

        // Best time
        ctx.fillStyle = '#00f2fe';
        let bestMin = Math.floor(this.bestTime / 60);
        let bestSec = Math.floor(this.bestTime % 60);
        ctx.fillText(`🏆 Рекорд: ${bestMin.toString().padStart(2, '0')}:${bestSec.toString().padStart(2, '0')}`, W / 2, H * 0.53);

        // Restart hint
        let hintAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 400);
        let hintSize = Math.min(18, W * 0.035);
        ctx.font = `${hintSize}px 'Inter', sans-serif`;
        ctx.fillStyle = `rgba(148, 163, 184, ${hintAlpha})`;
        let remaining = Math.max(0, this.POST_FALL_DURATION - this.postFallTimer);
        ctx.fillText(`Новий раунд через ${remaining.toFixed(0)}с...`, W / 2, H * 0.63);
    }

    // ========================================================================
    // STOP / CLEANUP
    // ========================================================================
    stop() {
        this.isActive = false;
        this.particles = [];
    }
};
