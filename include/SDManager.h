#ifndef SD_MANAGER_H
#define SD_MANAGER_H

#include <Arduino.h>
#include <SPI.h>
#include <FS.h>
#include "Config.h"
#undef FILE_READ
#undef FILE_WRITE
#undef FILE_APPEND
#include <SdFat.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>

// --- Configuration ---

#define LOG_BUFFER_SIZE 4096 // 4 KB RAM buffer
#define LOG_QUEUE_LENGTH 100 // FreeRTOS Queue for MPU6050

// --- Data Structures ---
// 1. File Header (For Forward Compatibility in OTA)
struct __attribute__((packed)) FileHeader {
    uint32_t magic;      // 0x52454842 ("REHB")
    uint16_t version;    // Structure version (1)
    uint16_t item_size;  // Size of one LogItem (32 bytes)
};

// 2. High-Frequency Log Item (MPU6050 Data)
struct __attribute__((packed)) LogItem {
    uint32_t timestamp;     // 4 bytes
    int16_t accel[3];       // 6 bytes
    int16_t gyro[3];        // 6 bytes
    uint16_t status;        // 2 bytes
    uint8_t reserved[14];   // 14 bytes padding for future sensors
}; // Exact size = 32 bytes

// 3. Session Index Entry (For index.bin)
#pragma pack(push, 1)
struct SessionIndexEntry {
    uint8_t status;        // 1 byte: 0x01 = ACTIVE, 0x00 = DELETED
    char patientId[12];    // 12 bytes
    uint32_t timestamp;    // 4 bytes
    float minAngle;        // 4 bytes
    float maxAngle;        // 4 bytes
    float amplitude;       // 4 bytes
    float avgSpeed;        // 4 bytes
    float smoothness;      // 4 bytes
    int32_t flexionsCount; // 4 bytes
    float holdingTime;     // 4 bytes
    char filepath[19];     // 19 bytes: e.g. "/d/1A/2B/1A2B.bin"
}; // 64 bytes total
#pragma pack(pop)

// Session Record (Runtime Analytics struct from AnalyticsEngine)
struct SessionRecord {
    String filename;
    String patientId;
    unsigned long timestamp;
    String dateStr;
    float minAngle;
    float maxAngle;
    float amplitude;
    float avgSpeed;
    float smoothness;
    int flexionsCount;
    float holdingTime;
};

// --- Globals ---
extern SdFs sd;
extern SemaphoreHandle_t sdMutex;
extern SemaphoreHandle_t indexMutex;

// --- SDManager Class ---
class SDManager {
public:
    static bool isReady();
    static void checkHealth();
    
    static bool init(uint8_t csPin = SD_CS_PIN);
    
    // Path Generators
    static void generateShardedPath(const char* id, char* outBuffer, size_t maxLen);

    // Session Management
    static void setSessionActive(const char* patientId, bool active);
    static void enqueueLogItem(const LogItem& item); // From MPU Interrupt/Core 1
    
    // JSON / Binary Summaries
    static bool saveSessionSummary(const SessionRecord& record);

    // Storage Status
    static size_t getTotalBytes();
    static size_t getFreeBytes();
    
private:
    static void logWriterTask(void *pvParameters);
    static void maintenanceTask(void *pvParameters);
    
    static void freeUpSpaceIfNeeded();
    static void compactIndex();

    static QueueHandle_t logQueue;
    static uint8_t ramBuffer[LOG_BUFFER_SIZE];
    static size_t bufferPos;
    static char currentLogPath[64];
    static bool isSessionActive;
    static bool isAvailable;
};

#endif
