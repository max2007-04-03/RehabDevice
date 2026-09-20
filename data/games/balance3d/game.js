// ============================================================================
// ⚖️ 3D Balance Robot — Pseudo-3D Cyberpunk Balancing Game
// RehabDevice IoT | MPU6050
// ============================================================================

window.RehabGames = window.RehabGames || {};

class Renderer3D {
    constructor(ctx, w, h) {
        this.ctx = ctx; this.W = w; this.H = h;
        this.faces = [];
    }
    
    clear() { this.faces = []; }

    addBox(tx, ty, tz, rz, w, h, d, colorMain, pivotY = 0) {
        let hw = w/2, hh = h/2, hd = d/2;
        let v = [
            [-hw, -hh - pivotY, -hd], [hw, -hh - pivotY, -hd], [hw, hh - pivotY, -hd], [-hw, hh - pivotY, -hd],
            [-hw, -hh - pivotY, hd], [hw, -hh - pivotY, hd], [hw, hh - pivotY, hd], [-hw, hh - pivotY, hd]
        ];
        
        let cosZ = Math.cos(rz), sinZ = Math.sin(rz);
        let worldV = v.map(p => {
            let x = p[0]*cosZ - p[1]*sinZ;
            let y = p[0]*sinZ + p[1]*cosZ;
            return [x + tx, y + ty, p[2] + tz];
        });

        this._addFaces(worldV, colorMain);
    }

    addBoxHierarchy(tx, ty, tz, rzParent, txChild, tyChild, rzChild, w, h, d, colorMain, pivotY = 0) {
        let hw = w/2, hh = h/2, hd = d/2;
        let v = [
            [-hw, -hh - pivotY, -hd], [hw, -hh - pivotY, -hd], [hw, hh - pivotY, -hd], [-hw, hh - pivotY, -hd],
            [-hw, -hh - pivotY, hd], [hw, -hh - pivotY, hd], [hw, hh - pivotY, hd], [-hw, hh - pivotY, hd]
        ];
        
        let cosC = Math.cos(rzChild), sinC = Math.sin(rzChild);
        let cosP = Math.cos(rzParent), sinP = Math.sin(rzParent);
        
        let worldV = v.map(p => {
            let lx = p[0]*cosC - p[1]*sinC + txChild;
            let ly = p[0]*sinC + p[1]*cosC + tyChild;
            let gx = lx*cosP - ly*sinP + tx;
            let gy = lx*sinP + ly*cosP + ty;
            return [gx, gy, p[2] + tz];
        });

        this._addFaces(worldV, colorMain);
    }

    _addFaces(worldV, colorMain) {
        let fDef = [
            [[0,1,2,3], 1.0], [[5,4,7,6], 0.6], [[3,2,6,7], 1.2], 
            [[4,5,1,0], 0.5], [[4,0,3,7], 0.8], [[1,5,6,2], 0.8]
        ];
        for (let f of fDef) {
            this.faces.push({ pts: f[0].map(i => worldV[i]), color: this._shade(colorMain, f[1]) });
        }
    }

    _shade(hex, factor) {
        let r = parseInt(hex.slice(1,3), 16) * factor;
        let g = parseInt(hex.slice(3,5), 16) * factor;
        let b = parseInt(hex.slice(5,7), 16) * factor;
        return `rgb(${Math.min(255,r)},${Math.min(255,g)},${Math.min(255,b)})`;
    }

    render(camPitch, camDist, fov, shakeX, shakeY) {
        let cosP = Math.cos(camPitch), sinP = Math.sin(camPitch);
        let projectedFaces = [];
        
        for (let f of this.faces) {
            let projPts = [];
            let avgZ = 0;
            for (let p of f.pts) {
                let y1 = p[1] * cosP - p[2] * sinP;
                let z1 = p[1] * sinP + p[2] * cosP;
                z1 -= camDist;
                avgZ += z1;
                if (z1 > -10) z1 = -10; // Prevent behind-camera glitches
                
                let sx = p[0] * fov / -z1;
                let sy = y1 * fov / -z1;
                projPts.push({ x: this.W/2 + sx + shakeX, y: this.H/2 - sy + shakeY });
            }
            avgZ /= 4;
            
            let v1x = projPts[1].x - projPts[0].x;
            let v1y = projPts[1].y - projPts[0].y;
            let v2x = projPts[2].x - projPts[0].x;
            let v2y = projPts[2].y - projPts[0].y;
            if (v1x*v2y - v1y*v2x >= 0) continue; // Backface culling

            projectedFaces.push({ pts: projPts, color: f.color, z: avgZ });
        }
        
        projectedFaces.sort((a, b) => a.z - b.z); // Painter's algorithm
        
        for (let f of projectedFaces) {
            this.ctx.fillStyle = f.color;
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.moveTo(f.pts[0].x, f.pts[0].y);
            for (let i=1; i<4; i++) this.ctx.lineTo(f.pts[i].x, f.pts[i].y);
            this.ctx.closePath();
            this.ctx.fill();
            this.ctx.stroke();
        }
    }
}

window.RehabGames['balance3d'] = class Balance3DGame {
    constructor(ctx, api) {
        this.ctx = ctx; this.api = api;
        this.width = ctx.canvas.width; this.height = ctx.canvas.height;
        this.calibMin = -30; this.calibMax = 30;
        
        this.renderer = new Renderer3D(ctx, this.width, this.height);
        
        this.init(this.calibMin, this.calibMax);
    }

    init(calibMin, calibMax) {
        this.calibMin = calibMin; this.calibMax = calibMax;
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        
        this.score = 0; this.timeAlive = 0; this.isGameOver = false;
        this.robotAngle = 0; this.robotVel = 0; this.boardAngle = 0;
        this.windForce = 0; this.difficulty = 1.0;
        this.cameraShake = 0; this.time = 0;
        this.api.updateHUD("hudScore", "⏱️ 0.0с");
        this.api.updateHUD("hudBotState", "🟢 Балансуй!");
    }

    resize(w, h) {
        this.width = w; this.height = h;
        if (this.renderer) {
            this.renderer.W = w;
            this.renderer.H = h;
        }
    }

    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;
        this.time += dt;

        let bc = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; bc = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; bc = true; }
        if (bc) this.api.updateCalibration(this.calibMin, this.calibMax);

        let range = this.calibMax - this.calibMin;
        let norm = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        norm = Math.max(0, Math.min(1, norm));
        let targetBoardAngle = (norm - 0.5) * 60;
        
        this.boardAngle += (targetBoardAngle - this.boardAngle) * 10 * dt;

        if (this.isGameOver) {
            this.gameOverTimer -= dt;
            this.robotAngle += this.robotVel * dt;
            this.cameraShake *= Math.pow(0.01, dt);
            if (this.gameOverTimer <= 0) this.init(this.calibMin, this.calibMax);
            return;
        }

        this.timeAlive += dt;
        this.score = this.timeAlive;
        this.difficulty = 1.0 + this.timeAlive * 0.02;

        if (Math.random() < dt * 0.5) {
            this.windForce = (Math.random() - 0.5) * 40 * this.difficulty;
        } else {
            this.windForce *= Math.pow(0.5, dt);
        }

        let gravityForce = this.robotAngle * 8.0; 
        let boardForce = -this.boardAngle * 9.0;
        let angularAccel = gravityForce + boardForce + this.windForce;
        
        this.robotVel += angularAccel * dt;
        this.robotVel *= Math.pow(0.5, dt);
        this.robotAngle += this.robotVel * dt;

        if (Math.abs(this.robotAngle) > 65) {
            this.isGameOver = true;
            this.gameOverTimer = 3.0;
            this.cameraShake = 20;
            this.api.updateHUD("hudBotState", "💥 РОБОТ ВПАВ!");
        } else {
            this.api.updateHUD("hudScore", `⏱️ ${this.score.toFixed(1)}с`);
            let state = Math.abs(this.robotAngle) < 15 ? "🟢 Ідеально" : (Math.abs(this.robotAngle) < 35 ? "🟡 Тримайся" : "🔴 КРИТИЧНО!");
            this.api.updateHUD("hudBotState", state);
        }
    }

    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;

        let shakeX = (Math.random() - 0.5) * this.cameraShake;
        let shakeY = (Math.random() - 0.5) * this.cameraShake;

        let bgGrad = ctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#09041a');
        bgGrad.addColorStop(0.5, '#1e0a3b');
        bgGrad.addColorStop(1, '#ff0055');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        let camPitch = -0.3; // Look down
        let camDist = 600;
        let fov = 700;

        this._draw3DGrid(ctx, camPitch, camDist, fov, W, H, shakeX, shakeY);

        this.renderer.clear();

        // Base Pillar (stationary)
        this.renderer.addBox(0, -150, 0, 0, 80, 300, 80, '#111111');
        
        // The Board (tilts)
        let bA = this.boardAngle * Math.PI / 180;
        this.renderer.addBox(0, 0, 0, bA, 300, 20, 100, '#00f2fe');

        // The Robot (tilts relative to world, tries to balance)
        let rA = this.robotAngle * Math.PI / 180;
        
        // Wheel
        this.renderer.addBox(0, 30, 0, rA, 40, 40, 40, '#333333');
        // Suspension
        this.renderer.addBox(0, 70, 0, rA, 16, 40, 16, '#555555');
        // Torso
        this.renderer.addBox(0, 140, 0, rA, 70, 100, 50, '#ff0055');
        // Head
        this.renderer.addBox(0, 210, 0, rA, 50, 40, 50, '#dddddd');

        // Arms (swing to balance)
        let armSwing = (this.robotVel * 0.5) * Math.PI / 180;
        if (this.isGameOver) armSwing = Math.PI * 0.8;

        // Left arm
        this.renderer.addBoxHierarchy(0, 170, 0, rA, -45, 0, Math.PI/4 + armSwing, 20, 80, 20, '#888888', 30);
        // Right arm
        this.renderer.addBoxHierarchy(0, 170, 0, rA, 45, 0, -Math.PI/4 + armSwing, 20, 80, 20, '#888888', 30);

        // Render everything
        this.renderer.render(camPitch, camDist, fov, shakeX, shakeY);

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

    _draw3DGrid(ctx, camPitch, camDist, fov, W, H, shakeX, shakeY) {
        let cosP = Math.cos(camPitch), sinP = Math.sin(camPitch);
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.3)';
        ctx.lineWidth = 2;
        
        let proj = (x, y, z) => {
            let y1 = y * cosP - z * sinP;
            let z1 = y * sinP + z * cosP;
            z1 -= camDist;
            if (z1 > -10) return null;
            let sx = x * fov / -z1;
            let sy = y1 * fov / -z1;
            return { x: W/2 + sx + shakeX, y: H/2 - sy + shakeY };
        };

        for (let x = -800; x <= 800; x += 150) {
            let p1 = proj(x, -200, -1000);
            let p2 = proj(x, -200, 1000);
            if (p1 && p2) {
                ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
            }
        }
        
        let speed = (this.time * 200) % 150;
        for (let z = -1000; z <= 1000; z += 150) {
            let az = z + speed;
            let p1 = proj(-800, -200, az);
            let p2 = proj(800, -200, az);
            if (p1 && p2) {
                ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
            }
        }
    }

    stop() {}
};
