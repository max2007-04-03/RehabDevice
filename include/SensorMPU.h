#ifndef SENSOR_MPU_H
#define SENSOR_MPU_H

#include <Arduino.h>
#include <Wire.h>
#include <I2Cdev.h>
#include <MPU6050_6Axis_MotionApps20.h>
#include "Config.h"

struct MPUData {
    float pitch;
    float roll;
    float yaw;
    float gyroX;
    float gyroY;
    float gyroZ;
    float accelX;
    float accelY;
    float accelZ;
    bool dataUpdated;
    unsigned long timestamp;
};

class SensorMPU {
public:
    SensorMPU();

    bool init();
    void update();
    bool recalibrate();
    MPUData getData();
    bool isReady() const;

    static void IRAM_ATTR dmpDataReadyISR();

private:
    MPU6050 mpu;
    bool dmpReady;
    uint8_t mpuIntStatus;
    uint8_t devStatus;
    uint16_t packetSize;
    uint16_t fifoCount;
    uint8_t fifoBuffer[64];

    Quaternion q;
    VectorFloat gravity;
    float ypr[3];

    float pitchOffset;
    float rollOffset;
    float yawOffset;

    MPUData currentData;

    // --- Error / health tracking -------------------------------------------
    // Timestamp of the last successfully decoded DMP packet (millis).
    // Zero until the first packet arrives.
    unsigned long lastSuccessMs;

    // Timestamp of the last I2C bus recovery attempt (millis).
    // Used to rate-limit recovery calls to once per 8 s.
    unsigned long lastRecoveryMs;

    // Timestamp of the last FIFO overflow (millis).
    // update() skips reads for 100 ms after each overflow.
    unsigned long lastOverflowMs;

    // Running count of FIFO overflows since the last successful read.
    unsigned long overflowCount;

    // Performs a 9-clock-pulse I2C bus recovery followed by Wire re-init.
    void recoverI2C();

    static volatile bool mpuInterrupt;
};

#endif // SENSOR_MPU_H
