// ============================================================================
// 🐉 VR Dragon Flight — Політ на драконі у стереоскопічному 3D
// RehabDevice IoT System | Google Cardboard VR + MPU6050 Sensor
// ============================================================================
// Стереоскопічний рендеринг: екран розділений на 2 половини (ліве/праве око)
// Управління: кисть (MPU6050) → вліво-вправо; голова (гіроскоп телефону) → огляд
// Тренує: амплітуду руху, координацію, плавність переходів
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['vrdragon'] = class VRDragonGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;

        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        // Calibration
        this.calibMin = -20;
        this.calibMax = 20;

        // VR stereo parameters
        this.eyeSeparation = 0.03;   // Normalized eye offset (3% of half-width)
        this.focalLength = 0.5;       // Depth convergence point

        // Head tracking (phone gyroscope)
        this.headYaw = 0;             // Left-right head rotation
        this.headPitch = 0;           // Up-down head rotation
        this.headTrackingEnabled = false;
        this._initHeadTracking();

        // Dragon position & flight
        this.dragonX = 0;             // -1 to 1 (lateral position)
        this.dragonTargetX = 0;
        this.dragonTilt = 0;          // Visual banking angle
        this.dragonBob = 0;           // Wing flap bobbing
        this.dragonBobPhase = 0;
        this.wingPhase = 0;           // Wing animation

        // World scrolling (forward flight)
        this.worldZ = 0;              // How far we've traveled
        this.speed = 1.0;             // Forward speed multiplier
        this.baseSpeed = 80;          // Units per second

        // Terrain / Mountains
        this.mountains = [];
        this.clouds = [];
        this.crystals = [];
        this.obstacles = [];          // Rock pillars to dodge
        this.stars = [];

        // Score & game state
        this.score = 0;
        this.crystalsCollected = 0;
        this.distanceTraveled = 0;
        this.isAlive = true;
        this.hitCooldown = 0;
        this.lives = 3;

        // Effects
        this.particles = [];
        this.speedLines = [];
        this.shakeIntensity = 0;
        this.flashAlpha = 0;
        this.flashColor = '';

        // Difficulty progression
        this.difficultyTimer = 0;
        this.obstacleSpawnTimer = 0;
        this.crystalSpawnTimer = 0;

        // Fog & atmosphere
        this.fogDensity = 0.0015;
        this.sunAngle = 0;
        this.timeOfDay = 0;           // 0-1 day cycle

        // VR mode indicator
        this.vrModeActive = true;

        // Generate initial world
        this._initWorld();
    }

    init(calibMin, calibMax) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);

        this.score = 0;
        this.crystalsCollected = 0;
        this.distanceTraveled = 0;
        this.isAlive = true;
        this.lives = 3;
        this.dragonX = 0;
        this.worldZ = 0;
        this.speed = 1.0;
        this.particles = [];

        this._initWorld();
        this._updateHUD();

        // Show VR instruction via custom HTML
        this.api.setCustomHTML(`
            <div style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
                        background:rgba(0,0,0,0.7);color:#00f2fe;padding:12px 24px;
                        border-radius:12px;font-size:14px;text-align:center;
                        border:1px solid rgba(0,242,254,0.3);pointer-events:none;z-index:20;">
                🐉 VR Дракон | Вставте телефон у Cardboard
            </div>
        `);
        setTimeout(() => this.api.clearCustomHTML(), 4000);
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
    }

    // ========================================================================
    // HEAD TRACKING (Phone Gyroscope)
    // ========================================================================
    _initHeadTracking() {
        // Request permission for DeviceOrientation (required on iOS 13+)
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            // iOS — need user gesture to request
            const handler = () => {
                DeviceOrientationEvent.requestPermission().then(state => {
                    if (state === 'granted') this._attachOrientationListener();
                }).catch(() => {});
                document.removeEventListener('touchstart', handler);
            };
            document.addEventListener('touchstart', handler, { once: true });
        } else {
            this._attachOrientationListener();
        }
    }

    _attachOrientationListener() {
        this._orientationHandler = (e) => {
            if (e.gamma !== null && e.beta !== null) {
                this.headTrackingEnabled = true;
                // gamma = left/right tilt (-90 to 90) → yaw
                // beta = front/back tilt (-180 to 180) → pitch
                // In landscape Cardboard mode:
                this.headYaw = (e.gamma || 0) * 0.015;    // Subtle head look
                this.headPitch = ((e.beta || 0) - 70) * 0.01; // Centered around ~70° (holding phone upright in cardboard)
            }
        };
        window.addEventListener('deviceorientation', this._orientationHandler);
    }

    // ========================================================================
    // WORLD GENERATION
    // ========================================================================
    _initWorld() {
        // Background stars
        this.stars = [];
        for (let i = 0; i < 80; i++) {
            this.stars.push({
                x: (Math.random() - 0.5) * 4,
                y: Math.random() * 0.6 - 0.1,
                z: 5 + Math.random() * 20,
                size: 0.5 + Math.random() * 1.5,
                twinkle: Math.random() * Math.PI * 2
            });
        }

        // Initial mountains
        this.mountains = [];
        for (let z = 2; z < 30; z += 1.5 + Math.random() * 2) {
            this._spawnMountain(z);
        }

        // Initial clouds
        this.clouds = [];
        for (let z = 3; z < 25; z += 2 + Math.random() * 3) {
            this._spawnCloud(z);
        }

        // Obstacles and crystals
        this.obstacles = [];
        this.crystals = [];
    }

    _spawnMountain(z) {
        let side = Math.random() > 0.5 ? 1 : -1;
        this.mountains.push({
            x: side * (0.6 + Math.random() * 1.2),
            z: z,
            width: 0.4 + Math.random() * 0.8,
            height: 0.3 + Math.random() * 0.7,
            color: Math.random() > 0.5 ? 0 : 1, // 0=gray, 1=brown
            snowCap: Math.random() > 0.4
        });
    }

    _spawnCloud(z) {
        this.clouds.push({
            x: (Math.random() - 0.5) * 3,
            y: 0.2 + Math.random() * 0.4,
            z: z,
            width: 0.2 + Math.random() * 0.4,
            height: 0.05 + Math.random() * 0.1,
            opacity: 0.15 + Math.random() * 0.25
        });
    }

    _spawnObstacle(z) {
        let laneX = (Math.random() - 0.5) * 1.4;
        this.obstacles.push({
            x: laneX,
            z: z,
            width: 0.12 + Math.random() * 0.1,
            height: 0.5 + Math.random() * 0.5,
            hit: false
        });
    }

    _spawnCrystal(z) {
        let laneX = (Math.random() - 0.5) * 1.6;
        this.crystals.push({
            x: laneX,
            y: 0.1 + Math.random() * 0.3,
            z: z,
            collected: false,
            rotPhase: Math.random() * Math.PI * 2,
            size: 0.04 + Math.random() * 0.02
        });
    }

    // ========================================================================
    // MAIN UPDATE
    // ========================================================================
    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;

        // Dynamic calibration
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

        // Map angle to dragon X position (-1 to 1)
        let range = this.calibMax - this.calibMin;
        let normalized = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        normalized = Math.max(0, Math.min(1, normalized));
        this.dragonTargetX = (normalized - 0.5) * 2;

        // Smooth dragon movement
        let prevX = this.dragonX;
        this.dragonX += (this.dragonTargetX - this.dragonX) * 6 * dt;

        // Dragon banking (tilt when turning)
        let deltaX = this.dragonX - prevX;
        let targetTilt = -deltaX * 800;
        targetTilt = Math.max(-35, Math.min(35, targetTilt));
        this.dragonTilt += (targetTilt - this.dragonTilt) * 5 * dt;

        // Wing flap animation
        this.wingPhase += dt * 4;
        this.dragonBobPhase += dt * 3;
        this.dragonBob = Math.sin(this.dragonBobPhase) * 0.015;

        // Effects decay
        this.shakeIntensity *= Math.pow(0.01, dt);
        if (this.shakeIntensity < 0.2) this.shakeIntensity = 0;
        this.flashAlpha = Math.max(0, this.flashAlpha - dt * 4);
        this.hitCooldown = Math.max(0, this.hitCooldown - dt);

        // Time of day cycle
        this.timeOfDay = (this.timeOfDay + dt * 0.01) % 1;
        this.sunAngle += dt * 0.05;

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += (p.vz || 0) * dt;
            p.vy += (p.gravity || 0) * dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }

        if (!this.isAlive) {
            // Death state — wait and respawn
            this.hitCooldown -= dt;
            if (this.hitCooldown <= 0) {
                this.isAlive = true;
                this.hitCooldown = 2;
            }
            this._updateHUD();
            return;
        }

        // === FORWARD FLIGHT ===
        let moveSpeed = this.baseSpeed * this.speed * dt;
        this.worldZ += moveSpeed * 0.05;
        this.distanceTraveled += moveSpeed;
        this.score += dt * 10 * this.speed;

        // Difficulty progression
        this.difficultyTimer += dt;
        this.speed = Math.min(2.5, 1.0 + this.difficultyTimer * 0.01);

        // Spawn management
        this.obstacleSpawnTimer -= dt;
        this.crystalSpawnTimer -= dt;

        if (this.obstacleSpawnTimer <= 0) {
            this._spawnObstacle(this.worldZ + 20 + Math.random() * 5);
            let spawnInterval = Math.max(0.8, 3 - this.difficultyTimer * 0.02);
            this.obstacleSpawnTimer = spawnInterval + Math.random() * spawnInterval;
        }

        if (this.crystalSpawnTimer <= 0) {
            this._spawnCrystal(this.worldZ + 15 + Math.random() * 10);
            this.crystalSpawnTimer = 1.5 + Math.random() * 2;
        }

        // Replenish mountains and clouds
        let maxZ = this.worldZ + 30;
        let lastMtnZ = this.mountains.length > 0 ? Math.max(...this.mountains.map(m => m.z)) : 0;
        while (lastMtnZ < maxZ) {
            lastMtnZ += 1.5 + Math.random() * 2;
            this._spawnMountain(lastMtnZ);
        }
        let lastCloudZ = this.clouds.length > 0 ? Math.max(...this.clouds.map(c => c.z)) : 0;
        while (lastCloudZ < maxZ) {
            lastCloudZ += 2 + Math.random() * 3;
            this._spawnCloud(lastCloudZ);
        }

        // Remove passed objects
        this.mountains = this.mountains.filter(m => m.z > this.worldZ - 2);
        this.clouds = this.clouds.filter(c => c.z > this.worldZ - 2);
        this.obstacles = this.obstacles.filter(o => o.z > this.worldZ - 2);
        this.crystals = this.crystals.filter(c => c.z > this.worldZ - 2);

        // === COLLISION DETECTION ===
        if (this.hitCooldown <= 0) {
            for (let obs of this.obstacles) {
                if (obs.hit) continue;
                let relZ = obs.z - this.worldZ;
                if (relZ > 0.3 && relZ < 1.5) {
                    let dx = Math.abs(this.dragonX - obs.x);
                    if (dx < obs.width * 0.8 + 0.1) {
                        obs.hit = true;
                        this.lives--;
                        this.shakeIntensity = 15;
                        this.flashAlpha = 1;
                        this.flashColor = '#ff1744';
                        this.hitCooldown = 2;
                        this.score = Math.max(0, this.score - 50);

                        // Spawn hit particles
                        for (let i = 0; i < 15; i++) {
                            this.particles.push({
                                x: this.dragonX, y: 0.15, z: this.worldZ + 1,
                                vx: (Math.random() - 0.5) * 2,
                                vy: Math.random() * 1.5,
                                vz: -Math.random() * 0.5,
                                life: 1, maxLife: 0.8,
                                size: 0.02 + Math.random() * 0.02,
                                color: '#ff6e40', gravity: -2
                            });
                        }

                        if (this.lives <= 0) {
                            this.isAlive = false;
                            this.hitCooldown = 3;
                            this.lives = 3;
                            this.score = Math.max(0, this.score - 100);
                            this.speed = 1.0;
                            this.difficultyTimer = Math.max(0, this.difficultyTimer - 20);
                        }
                        break;
                    }
                }
            }
        }

        // Crystal collection
        for (let cr of this.crystals) {
            if (cr.collected) continue;
            let relZ = cr.z - this.worldZ;
            if (relZ > 0 && relZ < 2) {
                let dx = Math.abs(this.dragonX - cr.x);
                if (dx < 0.2 && relZ < 1.2) {
                    cr.collected = true;
                    this.crystalsCollected++;
                    this.score += 50;
                    this.flashAlpha = 0.5;
                    this.flashColor = '#00f2fe';

                    // Sparkle particles
                    for (let i = 0; i < 10; i++) {
                        this.particles.push({
                            x: cr.x, y: cr.y, z: cr.z,
                            vx: (Math.random() - 0.5) * 1.5,
                            vy: Math.random() * 1,
                            vz: 0,
                            life: 1, maxLife: 0.6,
                            size: 0.015 + Math.random() * 0.01,
                            color: '#00f2fe', gravity: 0
                        });
                    }
                }
            }
        }

        // Speed lines (atmosphere)
        if (Math.random() < this.speed * 0.3) {
            this.particles.push({
                x: (Math.random() - 0.5) * 2.5,
                y: Math.random() * 0.8,
                z: this.worldZ + 8 + Math.random() * 5,
                vx: 0, vy: 0, vz: 0,
                life: 1, maxLife: 0.4,
                size: 0.003,
                color: 'rgba(255,255,255,0.4)',
                type: 'speedline'
            });
        }

        this._updateHUD();
    }

    // ========================================================================
    // HUD
    // ========================================================================
    _updateHUD() {
        let dist = Math.floor(this.distanceTraveled);
        let heartsStr = '❤️'.repeat(this.lives) + '🖤'.repeat(3 - this.lives);
        this.api.updateHUD("hudScore", `🐉 ${Math.floor(this.score)} очків | 💎 ${this.crystalsCollected} | ${heartsStr}`);
        this.api.updateHUD("hudBotState", `📏 ${dist}м | ⚡ x${this.speed.toFixed(1)}`);
    }

    // ========================================================================
    // MAIN DRAW (Stereoscopic)
    // ========================================================================
    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;
        const halfW = W / 2;

        ctx.save();

        // Draw LEFT eye
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, halfW, H);
        ctx.clip();
        this._drawEye(ctx, 0, 0, halfW, H, -this.eyeSeparation);
        ctx.restore();

        // Vertical divider line
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(halfW, 0);
        ctx.lineTo(halfW, H);
        ctx.stroke();

        // Draw RIGHT eye
        ctx.save();
        ctx.beginPath();
        ctx.rect(halfW, 0, halfW, H);
        ctx.clip();
        this._drawEye(ctx, halfW, 0, halfW, H, this.eyeSeparation);
        ctx.restore();

        // Flash overlay (full screen, on top)
        if (this.flashAlpha > 0) {
            ctx.fillStyle = this.flashColor;
            ctx.globalAlpha = this.flashAlpha * 0.2;
            ctx.fillRect(0, 0, W, H);
            ctx.globalAlpha = 1;
        }

        // Death overlay
        if (!this.isAlive) {
            ctx.fillStyle = 'rgba(10, 0, 0, 0.6)';
            ctx.fillRect(0, 0, W, H);

            let fs = Math.min(28, W * 0.04);
            ctx.font = `bold ${fs}px 'Inter', sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ff1744';
            ctx.fillText('💥 Зіткнення!', W * 0.25, H * 0.45);
            ctx.fillText('💥 Зіткнення!', W * 0.75, H * 0.45);

            let fs2 = Math.min(16, W * 0.025);
            ctx.font = `${fs2}px 'Inter', sans-serif`;
            ctx.fillStyle = '#94a3b8';
            let sec = Math.ceil(this.hitCooldown);
            ctx.fillText(`Перезапуск: ${sec}с`, W * 0.25, H * 0.55);
            ctx.fillText(`Перезапуск: ${sec}с`, W * 0.75, H * 0.55);
        }

        ctx.restore();
    }

    // ========================================================================
    // SINGLE EYE RENDER
    // ========================================================================
    _drawEye(ctx, ox, oy, vw, vh, eyeOffset) {
        // eyeOffset shifts the camera horizontally for stereo 3D
        let headOffsetX = this.headYaw * vw * 0.15;
        let headOffsetY = this.headPitch * vh * 0.1;

        // Screen shake
        let sx = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        let sy = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;

        let camOffX = eyeOffset * vw + headOffsetX + sx;
        let camOffY = headOffsetY + sy;

        // === SKY ===
        this._drawSky(ctx, ox, oy, vw, vh, camOffY);

        // === STARS ===
        this._drawStars(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === MOUNTAINS (background) ===
        this._drawMountains3D(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === CLOUDS ===
        this._drawClouds3D(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === GROUND / VALLEY BELOW ===
        this._drawGround(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === OBSTACLES ===
        this._drawObstacles3D(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === CRYSTALS ===
        this._drawCrystals3D(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === PARTICLES ===
        this._drawParticles3D(ctx, ox, oy, vw, vh, camOffX, camOffY);

        // === DRAGON (always in front) ===
        this._drawDragon(ctx, ox, oy, vw, vh, camOffX, camOffY);
    }

    // ========================================================================
    // 3D PROJECTION HELPER
    // ========================================================================
    _project(x, y, z, vw, vh, camOffX, camOffY) {
        // Simple perspective projection
        let relZ = z - this.worldZ;
        if (relZ <= 0.1) relZ = 0.1;
        let scale = this.focalLength / relZ;
        let sx = vw / 2 + (x * scale * vw) + camOffX;
        let sy = vh * 0.55 - (y * scale * vh) + camOffY;
        return { x: sx, y: sy, scale: scale };
    }

    // ========================================================================
    // SKY
    // ========================================================================
    _drawSky(ctx, ox, oy, vw, vh, camOffY) {
        let grad = ctx.createLinearGradient(ox, oy + camOffY, ox, oy + vh);
        // Sunset/sunrise cycle
        let t = this.timeOfDay;
        if (t < 0.25) { // Dawn
            grad.addColorStop(0, '#0a0e2a');
            grad.addColorStop(0.4, '#1a1040');
            grad.addColorStop(0.7, '#3d1550');
            grad.addColorStop(1, '#ff6f00');
        } else if (t < 0.5) { // Day
            grad.addColorStop(0, '#0a1628');
            grad.addColorStop(0.5, '#1a3050');
            grad.addColorStop(1, '#2a4a70');
        } else if (t < 0.75) { // Sunset
            grad.addColorStop(0, '#0a0e2a');
            grad.addColorStop(0.4, '#2a1040');
            grad.addColorStop(0.7, '#6a2040');
            grad.addColorStop(1, '#ff4500');
        } else { // Night
            grad.addColorStop(0, '#020510');
            grad.addColorStop(0.5, '#0a0e20');
            grad.addColorStop(1, '#101830');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(ox, oy, vw, vh);
    }

    // ========================================================================
    // STARS
    // ========================================================================
    _drawStars(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        let time = performance.now() / 1000;
        for (let s of this.stars) {
            let p = this._project(s.x, s.y + 0.5, this.worldZ + s.z, vw, vh, camOffX, camOffY);
            if (p.x < ox || p.x > ox + vw) continue;
            let twinkle = 0.4 + 0.6 * Math.sin(time * 2 + s.twinkle);
            ctx.fillStyle = `rgba(255, 255, 255, ${twinkle * 0.6})`;
            ctx.beginPath();
            ctx.arc(ox + p.x, oy + p.y, Math.max(0.5, s.size * p.scale * 2), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // ========================================================================
    // MOUNTAINS
    // ========================================================================
    _drawMountains3D(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        // Sort by distance (far first)
        let sorted = [...this.mountains].sort((a, b) => b.z - a.z);

        for (let m of sorted) {
            let relZ = m.z - this.worldZ;
            if (relZ < 0.5 || relZ > 25) continue;

            let p = this._project(m.x, 0, m.z, vw, vh, camOffX, camOffY);
            let scaleW = m.width * p.scale * vw;
            let scaleH = m.height * p.scale * vh;

            // Fog fade
            let fogFade = Math.max(0, 1 - relZ * this.fogDensity * 20);
            if (fogFade <= 0) continue;

            // Mountain color
            let baseR = m.color === 0 ? 40 : 50;
            let baseG = m.color === 0 ? 50 : 40;
            let baseB = m.color === 0 ? 65 : 45;

            ctx.globalAlpha = fogFade;
            ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
            ctx.beginPath();
            ctx.moveTo(ox + p.x - scaleW, oy + p.y);
            ctx.lineTo(ox + p.x - scaleW * 0.3, oy + p.y - scaleH);
            ctx.lineTo(ox + p.x, oy + p.y - scaleH * 1.1);
            ctx.lineTo(ox + p.x + scaleW * 0.4, oy + p.y - scaleH * 0.8);
            ctx.lineTo(ox + p.x + scaleW, oy + p.y);
            ctx.closePath();
            ctx.fill();

            // Snow cap
            if (m.snowCap) {
                ctx.fillStyle = `rgba(200, 215, 230, ${fogFade * 0.5})`;
                ctx.beginPath();
                ctx.moveTo(ox + p.x - scaleW * 0.15, oy + p.y - scaleH * 0.85);
                ctx.lineTo(ox + p.x, oy + p.y - scaleH * 1.1);
                ctx.lineTo(ox + p.x + scaleW * 0.2, oy + p.y - scaleH * 0.7);
                ctx.closePath();
                ctx.fill();
            }

            ctx.globalAlpha = 1;
        }
    }

    // ========================================================================
    // CLOUDS
    // ========================================================================
    _drawClouds3D(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        for (let c of this.clouds) {
            let relZ = c.z - this.worldZ;
            if (relZ < 0.5 || relZ > 20) continue;

            let p = this._project(c.x, c.y + 0.3, c.z, vw, vh, camOffX, camOffY);
            let cw = c.width * p.scale * vw;
            let ch = c.height * p.scale * vh;

            let fogFade = Math.max(0, 1 - relZ * this.fogDensity * 15);
            ctx.globalAlpha = c.opacity * fogFade;
            ctx.fillStyle = '#d0d8e8';

            // Cloud as ellipses
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, cw, ch, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(ox + p.x - cw * 0.5, oy + p.y + ch * 0.2, cw * 0.6, ch * 0.8, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(ox + p.x + cw * 0.4, oy + p.y + ch * 0.3, cw * 0.5, ch * 0.7, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = 1;
        }
    }

    // ========================================================================
    // GROUND
    // ========================================================================
    _drawGround(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        // Valley floor below
        let groundY = vh * 0.7 + camOffY;
        let grad = ctx.createLinearGradient(ox, oy + groundY, ox, oy + vh);
        grad.addColorStop(0, 'rgba(20, 35, 20, 0.3)');
        grad.addColorStop(1, 'rgba(10, 20, 15, 0.8)');
        ctx.fillStyle = grad;
        ctx.fillRect(ox, oy + groundY, vw, vh - groundY);
    }

    // ========================================================================
    // OBSTACLES (Rock Pillars)
    // ========================================================================
    _drawObstacles3D(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        let sorted = [...this.obstacles].sort((a, b) => b.z - a.z);

        for (let obs of sorted) {
            let relZ = obs.z - this.worldZ;
            if (relZ < -0.5 || relZ > 20) continue;

            let p = this._project(obs.x, 0, obs.z, vw, vh, camOffX, camOffY);
            let ow = obs.width * p.scale * vw;
            let oh = obs.height * p.scale * vh;

            let fogFade = Math.max(0.1, 1 - relZ * this.fogDensity * 12);

            // Rock pillar
            let rockGrad = ctx.createLinearGradient(ox + p.x - ow, 0, ox + p.x + ow, 0);
            rockGrad.addColorStop(0, `rgba(60, 50, 45, ${fogFade})`);
            rockGrad.addColorStop(0.5, `rgba(90, 75, 65, ${fogFade})`);
            rockGrad.addColorStop(1, `rgba(50, 40, 35, ${fogFade})`);

            ctx.fillStyle = rockGrad;
            ctx.beginPath();
            ctx.moveTo(ox + p.x - ow, oy + p.y);
            ctx.lineTo(ox + p.x - ow * 0.7, oy + p.y - oh);
            ctx.lineTo(ox + p.x + ow * 0.7, oy + p.y - oh);
            ctx.lineTo(ox + p.x + ow, oy + p.y);
            ctx.closePath();
            ctx.fill();

            // Warning glow when close
            if (relZ < 4 && !obs.hit) {
                let urgency = Math.max(0, 1 - relZ / 4);
                ctx.strokeStyle = `rgba(255, 23, 68, ${urgency * 0.5})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    // ========================================================================
    // CRYSTALS
    // ========================================================================
    _drawCrystals3D(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        let time = performance.now() / 1000;

        for (let cr of this.crystals) {
            if (cr.collected) continue;
            let relZ = cr.z - this.worldZ;
            if (relZ < 0 || relZ > 18) continue;

            let bobY = cr.y + Math.sin(time * 3 + cr.rotPhase) * 0.03;
            let p = this._project(cr.x, bobY, cr.z, vw, vh, camOffX, camOffY);
            let cs = cr.size * p.scale * vw;

            let fogFade = Math.max(0, 1 - relZ * this.fogDensity * 10);
            ctx.globalAlpha = fogFade;

            // Crystal glow
            ctx.shadowBlur = cs * 3;
            ctx.shadowColor = '#00f2fe';

            // Diamond shape
            ctx.fillStyle = '#00f2fe';
            ctx.beginPath();
            ctx.moveTo(ox + p.x, oy + p.y - cs);
            ctx.lineTo(ox + p.x + cs * 0.6, oy + p.y);
            ctx.lineTo(ox + p.x, oy + p.y + cs * 0.5);
            ctx.lineTo(ox + p.x - cs * 0.6, oy + p.y);
            ctx.closePath();
            ctx.fill();

            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        }
    }

    // ========================================================================
    // PARTICLES
    // ========================================================================
    _drawParticles3D(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        for (let p of this.particles) {
            let proj = this._project(p.x, p.y, p.z, vw, vh, camOffX, camOffY);
            let ps = p.size * proj.scale * vw;

            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;

            if (p.type === 'speedline') {
                ctx.fillRect(ox + proj.x - 1, oy + proj.y, 2, ps * 30);
            } else {
                ctx.beginPath();
                ctx.arc(ox + proj.x, oy + proj.y, Math.max(1, ps), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    // ========================================================================
    // DRAGON (Third Person)
    // ========================================================================
    _drawDragon(ctx, ox, oy, vw, vh, camOffX, camOffY) {
        // Dragon is at fixed screen position (bottom center, close to camera)
        let dx = vw / 2 + this.dragonX * vw * 0.3 + camOffX;
        let dy = vh * 0.68 + this.dragonBob * vh + camOffY;
        let scale = Math.min(vw, vh) * 0.0015;
        if (scale < 0.4) scale = 0.4;

        // Invincibility flash
        if (this.hitCooldown > 0 && this.isAlive) {
            if (Math.floor(performance.now() / 100) % 2 === 0) {
                ctx.globalAlpha = 0.4;
            }
        }

        ctx.save();
        ctx.translate(ox + dx, oy + dy);
        ctx.rotate(this.dragonTilt * Math.PI / 180);
        ctx.scale(scale, scale);

        let wingAngle = Math.sin(this.wingPhase) * 0.5;

        // --- TAIL ---
        ctx.strokeStyle = '#2E7D32';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(0, 30);
        ctx.quadraticCurveTo(
            -10 + Math.sin(this.wingPhase * 0.7) * 15, 60,
            -5 + Math.sin(this.wingPhase * 0.5) * 20, 80
        );
        ctx.stroke();
        // Tail tip
        ctx.fillStyle = '#FF6F00';
        ctx.beginPath();
        let tailTipX = -5 + Math.sin(this.wingPhase * 0.5) * 20;
        ctx.moveTo(tailTipX, 80);
        ctx.lineTo(tailTipX - 8, 90);
        ctx.lineTo(tailTipX + 8, 90);
        ctx.closePath();
        ctx.fill();

        // --- WINGS ---
        let wSpan = 80;
        let wH = 25;

        // Left wing
        ctx.save();
        ctx.translate(-15, -5);
        ctx.rotate(-wingAngle - 0.3);
        let lwGrad = ctx.createLinearGradient(0, 0, -wSpan, -wH);
        lwGrad.addColorStop(0, '#388E3C');
        lwGrad.addColorStop(1, 'rgba(56, 142, 60, 0.4)');
        ctx.fillStyle = lwGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-wSpan * 0.4, -wH * 1.5, -wSpan, -wH * 0.3);
        ctx.lineTo(-wSpan * 0.8, wH * 0.5);
        ctx.quadraticCurveTo(-wSpan * 0.3, wH * 0.3, 0, 10);
        ctx.closePath();
        ctx.fill();
        // Wing membrane lines
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.moveTo(0, i * 2);
            ctx.lineTo(-wSpan * (i / 4), -wH * 0.2 + i * 5);
            ctx.stroke();
        }
        ctx.restore();

        // Right wing
        ctx.save();
        ctx.translate(15, -5);
        ctx.rotate(wingAngle + 0.3);
        let rwGrad = ctx.createLinearGradient(0, 0, wSpan, -wH);
        rwGrad.addColorStop(0, '#388E3C');
        rwGrad.addColorStop(1, 'rgba(56, 142, 60, 0.4)');
        ctx.fillStyle = rwGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(wSpan * 0.4, -wH * 1.5, wSpan, -wH * 0.3);
        ctx.lineTo(wSpan * 0.8, wH * 0.5);
        ctx.quadraticCurveTo(wSpan * 0.3, wH * 0.3, 0, 10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.moveTo(0, i * 2);
            ctx.lineTo(wSpan * (i / 4), -wH * 0.2 + i * 5);
            ctx.stroke();
        }
        ctx.restore();

        // --- BODY ---
        let bodyGrad = ctx.createLinearGradient(0, -30, 0, 35);
        bodyGrad.addColorStop(0, '#2E7D32');
        bodyGrad.addColorStop(0.5, '#388E3C');
        bodyGrad.addColorStop(1, '#1B5E20');
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        ctx.ellipse(0, 10, 16, 30, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly (lighter)
        ctx.fillStyle = '#A5D6A7';
        ctx.beginPath();
        ctx.ellipse(0, 15, 10, 18, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly scale lines
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 0.5;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(-8, 10 + i * 6);
            ctx.lineTo(8, 10 + i * 6);
            ctx.stroke();
        }

        // --- LEGS ---
        ctx.fillStyle = '#2E7D32';
        // Left leg
        ctx.beginPath();
        ctx.ellipse(-12, 30, 5, 8, -0.3, 0, Math.PI * 2);
        ctx.fill();
        // Right leg
        ctx.beginPath();
        ctx.ellipse(12, 30, 5, 8, 0.3, 0, Math.PI * 2);
        ctx.fill();

        // --- NECK & HEAD ---
        // Neck
        ctx.fillStyle = '#2E7D32';
        ctx.beginPath();
        ctx.moveTo(-8, -20);
        ctx.quadraticCurveTo(-4, -40, 0, -48);
        ctx.quadraticCurveTo(4, -40, 8, -20);
        ctx.closePath();
        ctx.fill();

        // Head
        let headGrad = ctx.createRadialGradient(0, -52, 0, 0, -52, 14);
        headGrad.addColorStop(0, '#43A047');
        headGrad.addColorStop(1, '#2E7D32');
        ctx.fillStyle = headGrad;
        ctx.beginPath();
        ctx.ellipse(0, -52, 13, 11, 0, 0, Math.PI * 2);
        ctx.fill();

        // Snout
        ctx.fillStyle = '#388E3C';
        ctx.beginPath();
        ctx.ellipse(0, -62, 8, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Nostrils
        ctx.fillStyle = '#1B5E20';
        ctx.beginPath();
        ctx.arc(-3, -64, 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(3, -64, 1.5, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = '#FFD600';
        ctx.beginPath();
        ctx.ellipse(-7, -54, 4, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -54, 4, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Pupils (vertical slit)
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.ellipse(-7, -54, 1.5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -54, 1.5, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eye glow
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#FFD600';
        ctx.fillStyle = 'rgba(255, 214, 0, 0.2)';
        ctx.beginPath();
        ctx.arc(-7, -54, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(7, -54, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Horns
        ctx.fillStyle = '#5D4037';
        // Left horn
        ctx.beginPath();
        ctx.moveTo(-10, -60);
        ctx.lineTo(-16, -72);
        ctx.lineTo(-8, -62);
        ctx.closePath();
        ctx.fill();
        // Right horn
        ctx.beginPath();
        ctx.moveTo(10, -60);
        ctx.lineTo(16, -72);
        ctx.lineTo(8, -62);
        ctx.closePath();
        ctx.fill();

        // Spinal ridges
        ctx.fillStyle = '#FF6F00';
        for (let i = 0; i < 5; i++) {
            let ry = -45 + i * 14;
            let rs = 4 - i * 0.5;
            ctx.beginPath();
            ctx.moveTo(0, ry - rs);
            ctx.lineTo(-rs * 0.6, ry + rs * 0.5);
            ctx.lineTo(rs * 0.6, ry + rs * 0.5);
            ctx.closePath();
            ctx.fill();
        }

        // --- FIRE BREATH (when moving fast) ---
        if (this.speed > 1.3) {
            let fireAlpha = Math.min(1, (this.speed - 1.3) * 2);
            let fireLen = 15 + Math.random() * 10;
            ctx.globalAlpha = fireAlpha * 0.7;

            let fireGrad = ctx.createLinearGradient(0, -68, 0, -68 - fireLen);
            fireGrad.addColorStop(0, '#FF6F00');
            fireGrad.addColorStop(0.5, '#FF3D00');
            fireGrad.addColorStop(1, 'rgba(255, 0, 0, 0)');
            ctx.fillStyle = fireGrad;
            ctx.beginPath();
            ctx.moveTo(-4, -68);
            ctx.lineTo(0, -68 - fireLen);
            ctx.lineTo(4, -68);
            ctx.closePath();
            ctx.fill();

            ctx.globalAlpha = 1;
        }

        ctx.restore();
        ctx.globalAlpha = 1;
    }

    // ========================================================================
    // STOP / CLEANUP
    // ========================================================================
    stop() {
        this.particles = [];
        if (this._orientationHandler) {
            window.removeEventListener('deviceorientation', this._orientationHandler);
        }
    }
};
