#include "SensorMPU.h"

volatile bool SensorMPU::mpuInterrupt = false;

void IRAM_ATTR SensorMPU::dmpDataReadyISR() {
    mpuInterrupt = true;
}

SensorMPU::SensorMPU() : dmpReady(false), mpuIntStatus(0), devStatus(0), packetSize(0), fifoCount(0),
                         calibrated(false),
                         lastSuccessMs(0), lastRecoveryMs(0), lastOverflowMs(0), overflowCount(0) {
    qCalibInv.w = 1.0f; qCalibInv.x = 0.0f; qCalibInv.y = 0.0f; qCalibInv.z = 0.0f;
    memset(&currentData, 0, sizeof(currentData));
}

bool SensorMPU::init() {
    // 100 kHz is significantly more stable for GY-521 clone chips (WHO_AM_I = 0x70)
    // on breadboards with long wires and no dedicated pull-ups.
    // The higher capacitance of breadboard connections causes edge degradation
    // at 400 kHz which manifests as "i2cWriteReadNonStop returned Error -1".
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    Wire.setTimeOut(20); // 20 ms timeout: long enough for a healthy 100 kHz read,
                         // short enough to unblock the loop when bus is stuck.
    delay(100);

    // Check WHO_AM_I register (0x75) to identify chip (MPU6050/6500/clone)
    Wire.beginTransmission(0x68);
    Wire.write(0x75);
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)0x68, (uint8_t)1, (uint8_t)true);
    uint8_t whoAmI = Wire.read();
    Serial.printf("[SensorMPU] WHO_AM_I register (0x75) returned ID: 0x%02X\n", whoAmI);

    mpu.initialize();
    delay(50);

    bool conn = mpu.testConnection();
    if (!conn && whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73 && whoAmI != 0x98) {
        Serial.printf("[SensorMPU] Error: MPU6050 not found (testConnection=false, whoAmI=0x%02X)!\n", whoAmI);
        return false;
    } else if (!conn) {
        Serial.printf("[SensorMPU] Warning: testConnection() returned false, but chip answered (ID 0x%02X). Continuing...\n", whoAmI);
    }

    Serial.println("[SensorMPU] Loading DMP firmware to MPU6050...");
    devStatus = mpu.dmpInitialize();

    mpu.setXGyroOffset(0);
    mpu.setYGyroOffset(0);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1688);

    if (devStatus == 0) {
        Serial.println("[SensorMPU] Auto-calibrating gyro and accel...");
        mpu.CalibrateAccel(6);
        mpu.CalibrateGyro(6);
        mpu.PrintActiveOffsets();

        // REMOVED: setRate() ruins DMP integration math (scales down angles)
        // mpu.setRate(9);

        Serial.println("[SensorMPU] Enabling DMP...");
        mpu.setDMPEnabled(true);

        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);

        mpuIntStatus = mpu.getIntStatus();
        packetSize = mpu.dmpGetFIFOPacketSize();
        dmpReady = true;

        Wire.setClock(100000); // Keep 100 kHz after DMP init
        mpu.resetFIFO();
        mpuInterrupt  = false;
        fifoCount     = 0;
        lastSuccessMs  = 0;
        lastRecoveryMs = 0;
        lastOverflowMs = 0;
        overflowCount  = 0;

        Serial.println("[SensorMPU] DMP initialized successfully! Ready (100 kHz, 20 Hz).");
        return true;
    } else {
        Serial.printf("[SensorMPU] DMP initialization error (code %d)\n", devStatus);
        return false;
    }
}

// ---------------------------------------------------------------------------
// I2C bus recovery
//
// Sends up to 9 SCL clock pulses to force any slave that is holding SDA low
// to release it, then issues a STOP condition and re-initialises Wire.
// Because Wire.begin() stops and restarts the I2C peripheral it must be
// followed by Wire.setClock() to restore the desired speed.
//
// NOTE: recoverI2C() does NOT reinitialise the MPU6050 registers.
//       The chip's internal DMP state and calibration survive as long as
//       power is maintained; only the I2C bus driver on the host side is reset.
// ---------------------------------------------------------------------------
void SensorMPU::recoverI2C() {
    Serial.println("[SensorMPU] Performing I2C bus recovery (9-clock pulse)...");

    // Temporarily take GPIO control of SCL / SDA
    pinMode(PIN_I2C_SCL, OUTPUT);
    pinMode(PIN_I2C_SDA, OUTPUT);
    digitalWrite(PIN_I2C_SCL, HIGH);
    digitalWrite(PIN_I2C_SDA, HIGH);
    delayMicroseconds(10);

    for (int i = 0; i < 9; i++) {
        digitalWrite(PIN_I2C_SCL, LOW);
        delayMicroseconds(5);
        digitalWrite(PIN_I2C_SCL, HIGH);
        delayMicroseconds(5);
        if (digitalRead(PIN_I2C_SDA) == HIGH) break; // Slave released SDA
    }

    // STOP condition: SDA rises while SCL is HIGH
    digitalWrite(PIN_I2C_SDA, LOW);
    delayMicroseconds(5);
    digitalWrite(PIN_I2C_SCL, HIGH);
    delayMicroseconds(5);
    digitalWrite(PIN_I2C_SDA, HIGH);
    delayMicroseconds(5);

    // Return SCL/SDA to open-drain Wire control
    pinMode(PIN_I2C_SCL, INPUT_PULLUP);
    pinMode(PIN_I2C_SDA, INPUT_PULLUP);
    delayMicroseconds(10);

    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    Wire.setTimeOut(20);

    // Allow the MPU6050 to settle before the next I2C transaction
    delay(10);

    // If the sensor browned out and reset, its sleep mode is enabled (default)
    // or DMP is disabled. We must re-initialize it completely.
    if (mpu.getSleepEnabled() || !mpu.testConnection()) {
        Serial.println("[SensorMPU] MPU6050 seems to have reset (brownout)! Re-initializing...");
        if (init()) {
            Serial.println("[SensorMPU] Re-initialization successful.");
        } else {
            Serial.println("[SensorMPU] Re-initialization failed.");
        }
    } else {
        mpu.resetFIFO();
        mpuInterrupt = false;
        fifoCount    = 0;
    }

    Serial.println("[SensorMPU] I2C bus recovery complete.");
}


void SensorMPU::update() {
    if (!dmpReady) return;

    // --- Back-off after FIFO overflow (100 ms cooldown) ---
    if (lastOverflowMs != 0 && (millis() - lastOverflowMs) < 100) {
        return;
    }

    // Nothing to do yet
    if (!mpuInterrupt && fifoCount < packetSize) {
        return;
    }

    unsigned long now = millis();

    // --- Stall detection --------------------------------------------------
    // If the interrupt flag has been set but we have not decoded a valid
    // packet for more than 800 ms the I2C bus is likely stuck.
    // Trigger a recovery at most once every 8 seconds to avoid hammering
    // Wire.begin() and disrupting SD-card SPI timing.
    // (The 800 ms threshold is well above the 50 ms packet interval at 20 Hz.)
    if (lastSuccessMs > 0 && mpuInterrupt && (now - lastSuccessMs) > 800) {
        if (now - lastRecoveryMs > 8000) {
            recoverI2C();
            lastRecoveryMs = now;
        } else {
            // Recovery throttled — just reset FIFO and wait
            mpu.resetFIFO();
            mpuInterrupt = false;
            fifoCount    = 0;
        }
        return;
    }

    mpuInterrupt  = false;
    mpuIntStatus  = mpu.getIntStatus();
    fifoCount     = mpu.getFIFOCount();

    // --- FIFO overflow handling -------------------------------------------
    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_FIFO_OFLOW_BIT)) || fifoCount >= 1024) {
        overflowCount++;
        lastOverflowMs = now;

        // Throttle Serial output: print only every 5th overflow
        if (overflowCount % 5 == 1) {
            Serial.printf("[SensorMPU] FIFO overflow #%lu — buffer reset\n", overflowCount);
        }

        mpu.resetFIFO();
        fifoCount    = 0;
        mpuInterrupt = false;
        return;
    }

    // --- Normal DMP packet read -------------------------------------------
    if ((mpuIntStatus & 0x02) || fifoCount >= packetSize) {
        if (mpu.dmpGetCurrentFIFOPacket(fifoBuffer)) {
            fifoCount = mpu.getFIFOCount();

            mpu.dmpGetQuaternion(&q, fifoBuffer);

            float normSq = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
            if (normSq < 0.5f || normSq > 1.5f || isnan(q.w) || isnan(q.x) || isnan(q.y) || isnan(q.z)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            // Apply quaternion calibration: q_corrected = q_calibInv * q_raw
            // This correctly removes the initial orientation without yaw-drift coupling
            Quaternion qCorrected;
            if (calibrated) {
                qCorrected.w = qCalibInv.w * q.w - qCalibInv.x * q.x - qCalibInv.y * q.y - qCalibInv.z * q.z;
                qCorrected.x = qCalibInv.w * q.x + qCalibInv.x * q.w + qCalibInv.y * q.z - qCalibInv.z * q.y;
                qCorrected.y = qCalibInv.w * q.y - qCalibInv.x * q.z + qCalibInv.y * q.w + qCalibInv.z * q.x;
                qCorrected.z = qCalibInv.w * q.z + qCalibInv.x * q.y - qCalibInv.y * q.x + qCalibInv.z * q.w;
            } else {
                qCorrected = q;
            }

            mpu.dmpGetGravity(&gravity, &qCorrected);
            mpu.dmpGetYawPitchRoll(ypr, &qCorrected, &gravity);

            int16_t gx, gy, gz, ax, ay, az;
            mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

            float rawYaw   = ypr[0] * 180.0f / M_PI;
            float rawPitch = ypr[1] * 180.0f / M_PI;
            float rawRoll  = ypr[2] * 180.0f / M_PI;

            if (isnan(rawRoll) || isnan(rawPitch) || isnan(rawYaw)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            currentData.yaw   = rawYaw;
            currentData.pitch = rawPitch;
            currentData.roll  = rawRoll;

            // Convert gyro to deg/sec (131 LSB/deg/s) and accel to g (16384 LSB/g)
            currentData.gyroX = gx / 131.0f;
            currentData.gyroY = gy / 131.0f;
            currentData.gyroZ = gz / 131.0f;

            currentData.accelX = ax / 16384.0f;
            currentData.accelY = ay / 16384.0f;
            currentData.accelZ = az / 16384.0f;

            currentData.dataUpdated = true;
            currentData.timestamp   = millis();

            // Successful read — reset all error counters
            lastSuccessMs = millis();
            overflowCount = 0;
        }
    }
}

bool SensorMPU::recalibrate() {
    if (!dmpReady) return false;

    Serial.println("[SensorMPU] Performing on-the-fly recalibration...");

    mpuInterrupt = false;
    mpu.resetFIFO();

    delay(50);
    uint16_t count = mpu.getFIFOCount();
    while (count < packetSize) {
        delay(10);
        count = mpu.getFIFOCount();
    }

    uint8_t buffer[64];
    if (!mpu.dmpGetCurrentFIFOPacket(buffer)) {
        mpu.resetFIFO();
        return false;
    }

    Quaternion tempQ;
    VectorFloat tempGravity;
    float tempYPR[3];
    mpu.dmpGetQuaternion(&tempQ, buffer);
    mpu.dmpGetGravity(&tempGravity, &tempQ);
    mpu.dmpGetYawPitchRoll(tempYPR, &tempQ, &tempGravity);

    if (isnan(tempYPR[0]) || isnan(tempYPR[1]) || isnan(tempYPR[2])) {
        mpu.resetFIFO();
        return false;
    }

    // Store the conjugate (inverse) of the current quaternion for future correction.
    // For a unit quaternion, the conjugate is: (w, -x, -y, -z)
    qCalibInv.w =  tempQ.w;
    qCalibInv.x = -tempQ.x;
    qCalibInv.y = -tempQ.y;
    qCalibInv.z = -tempQ.z;
    calibrated = true;

    mpu.resetFIFO();
    mpuInterrupt = false;
    fifoCount    = 0;
    Serial.printf("[SensorMPU] Recalibration complete! Calibration quaternion stored: w=%.4f, x=%.4f, y=%.4f, z=%.4f\n", 
                  tempQ.w, tempQ.x, tempQ.y, tempQ.z);
    return true;
}

MPUData SensorMPU::getData() {
    MPUData result = currentData;
    currentData.dataUpdated = false;
    return result;
}

bool SensorMPU::isReady() const {
    return dmpReady;
}
