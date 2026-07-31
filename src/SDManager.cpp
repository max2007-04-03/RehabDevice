#include "SDManager.h"
#include <ArduinoJson.h>

SdFs sd;
SemaphoreHandle_t sdMutex = NULL;
SemaphoreHandle_t indexMutex = NULL;

QueueHandle_t SDManager::logQueue = NULL;
uint8_t SDManager::ramBuffer[LOG_BUFFER_SIZE];
size_t SDManager::bufferPos = 0;
char SDManager::currentLogPath[64] = {0};
bool SDManager::isSessionActive = false;
bool SDManager::isAvailable = false;
volatile uint32_t droppedFrames = 0;

bool SDManager::isReady() {
    return isAvailable;
}

void SDManager::checkHealth() {
    if (isAvailable && sd.sdErrorCode() != 0) {
        isAvailable = false;
        Serial.printf("[SDManager] HARDWARE ERROR DETECTED! SD Card marked as UNAVAILABLE. Error Code: 0x%X\n", sd.sdErrorCode());
    }
}

bool SDManager::init(uint8_t csPin) {
    if (sdMutex == NULL) {
        sdMutex = xSemaphoreCreateMutex();
    }
    if (indexMutex == NULL) {
        indexMutex = xSemaphoreCreateMutex();
    }
    
    // SD cards on breadboards can fail to respond to CMD0 right after power-on.
    // Give the card 300 ms to stabilise, then retry at lower SPI speeds if needed.
    // Sequence: 4 MHz → 1 MHz, 300 ms apart.
    static const uint32_t speeds[] = {4, 1};
    bool mounted = false;
    for (int attempt = 0; attempt < 2; attempt++) {
        delay(300);
        if (sd.begin(csPin, SD_SCK_MHZ(speeds[attempt]))) {
            Serial.printf("[SDManager] SD Card mounted at %u MHz (attempt %d)\n",
                          speeds[attempt], attempt + 1);
            mounted = true;
            break;
        }
        Serial.printf("[SDManager] SD Card mount failed at %u MHz (Error: 0x%X, Data: 0x%X)\n",
                      speeds[attempt], sd.sdErrorCode(), sd.sdErrorData());
        sd.end(); // Reset SdFat state before retrying
    }
    if (!mounted) {
        Serial.println("[SDManager] SD Card could not be mounted after 3 attempts!");
        isAvailable = false;
        return false;
    }
    
    isAvailable = true;
    Serial.println("[SDManager] SD Card mounted successfully!");
    Serial.println("[SDManager] --- Root Directory Contents ---");
    FsFile root = sd.open("/");
    if (root) {
        FsFile file;
        while (file.openNext(&root, O_READ)) {
            char name[64];
            file.getName(name, sizeof(name));
            if (file.isDirectory()) {
                Serial.printf("[SDManager]   [DIR]  %s\n", name);
            } else {
                Serial.printf("[SDManager]   [FILE] %s (Size: %u bytes)\n", name, (unsigned int)file.size());
            }
            file.close();
        }
        root.close();
    } else {
        Serial.println("[SDManager] Failed to open root directory");
    }
    Serial.println("[SDManager] -------------------------------");

    // Create base directories
    if (!sd.exists("/d")) sd.mkdir("/d");


    logQueue = xQueueCreate(LOG_QUEUE_LENGTH, sizeof(LogItem));
    
    xTaskCreatePinnedToCore(
        SDManager::logWriterTask, 
        "LogWriter", 
        4096, 
        NULL, 
        2, 
        NULL, 
        0 // Core 0 (I/O)
    );
    
    xTaskCreatePinnedToCore(
        SDManager::maintenanceTask, 
        "Maintenance", 
        4096, 
        NULL, 
        1, // Low priority
        NULL, 
        0 // Core 0 (I/O)
    );
    
    Serial.println("[SDManager] Initialized successfully");
    return true;
}

void SDManager::generateShardedPath(const char* id, char* outBuffer, size_t maxLen) {
    if (strlen(id) < 4) {
        snprintf(outBuffer, maxLen, "/d/00/00/%s.bin", id);
        return;
    }
    snprintf(outBuffer, maxLen, "/d/%c%c/%c%c/%s.bin", 
             id[0], id[1], id[2], id[3], id);
}

void SDManager::setSessionActive(const char* patientId, bool active) {
    isSessionActive = active;
    if (active && patientId != nullptr) {
        generateShardedPath(patientId, currentLogPath, sizeof(currentLogPath));
        
        // Ensure sharded directories exist
        char dir1[16], dir2[32];
        if (strlen(patientId) >= 4) {
            snprintf(dir1, sizeof(dir1), "/d/%c%c", patientId[0], patientId[1]);
            snprintf(dir2, sizeof(dir2), "/d/%c%c/%c%c", patientId[0], patientId[1], patientId[2], patientId[3]);
            
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                if (!sd.exists(dir1)) sd.mkdir(dir1);
                if (!sd.exists(dir2)) sd.mkdir(dir2);
                xSemaphoreGive(sdMutex);
            }
        }
        
        bufferPos = 0; // Reset buffer for new session
    }
}

void SDManager::enqueueLogItem(const LogItem& item) {
    if (!isSessionActive) return;
    
    // Non-blocking write to queue (0 ticks timeout)
    if (xQueueSend(logQueue, &item, 0) != pdTRUE) {
        droppedFrames++; // Queue is full, drop to protect MPU task
    }
}

void SDManager::logWriterTask(void *pvParameters) {
    LogItem item;
    
    while (true) {
        // Block indefinitely until an item arrives
        if (xQueueReceive(logQueue, &item, portMAX_DELAY) == pdTRUE) {
            memcpy(&ramBuffer[bufferPos], &item, sizeof(LogItem));
            bufferPos += sizeof(LogItem);
            
            // Check if buffer is full
            if (bufferPos + sizeof(LogItem) > LOG_BUFFER_SIZE) {
                // Wait for SD Mutex (Web Server might be holding it for download chunks)
                if (xSemaphoreTake(sdMutex, portMAX_DELAY) == pdTRUE) {
                    FsFile file = sd.open(currentLogPath, O_WRITE | O_CREAT | O_AT_END);
                    if (file) {
                        // Forward Compatibility: Write FileHeader for a totally new file
                        if (file.size() == 0) {
                            FileHeader header = {0x52454842, 1, 32};
                            file.write((const uint8_t*)&header, sizeof(FileHeader));
                        }
                        // Dump 4KB block
                        file.write(ramBuffer, bufferPos);
                        file.sync(); // Force write to physical SD
                        file.close();
                    }
                    xSemaphoreGive(sdMutex);
                }
                bufferPos = 0; // Reset buffer
            }
        }
    }
}

bool SDManager::saveSessionSummary(const SessionRecord& record) {
    SessionIndexEntry entry;
    memset(&entry, 0, sizeof(SessionIndexEntry));
    entry.status = 0x01; // ACTIVE
    strncpy(entry.patientId, record.patientId.c_str(), sizeof(entry.patientId) - 1);
    entry.timestamp = record.timestamp;
    entry.minAngle = record.minAngle;
    entry.maxAngle = record.maxAngle;
    entry.amplitude = record.amplitude;
    entry.avgSpeed = record.avgSpeed;
    entry.smoothness = record.smoothness;
    entry.flexionsCount = record.flexionsCount;
    entry.holdingTime = record.holdingTime;
    
    // Store exact filepath in index
    generateShardedPath(record.patientId.c_str(), entry.filepath, sizeof(entry.filepath));
    
    if (xSemaphoreTake(indexMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
            FsFile file = sd.open("/index.bin", O_WRITE | O_CREAT | O_AT_END);
            if (file) {
                file.write((const uint8_t*)&entry, sizeof(SessionIndexEntry));
                file.close();
            }
            xSemaphoreGive(sdMutex);
        }
        xSemaphoreGive(indexMutex);
        return true;
    }
    return false;
}

void SDManager::maintenanceTask(void *pvParameters) {
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(60 * 60 * 1000)); // Check every hour
        if (!isSessionActive) {
            freeUpSpaceIfNeeded();
            compactIndex();
        }
    }
}

void SDManager::freeUpSpaceIfNeeded() {
    size_t total = getTotalBytes();
    if (total == 0) return;
    
    while (true) {
        size_t freeSpace = getFreeBytes();
        float freePercent = (float)freeSpace / total;
        
        if (freePercent > 0.15f) break; // Low Watermark (85% full)
        
        if (xSemaphoreTake(indexMutex, portMAX_DELAY) == pdTRUE) {
            if (xSemaphoreTake(sdMutex, portMAX_DELAY) == pdTRUE) {
                FsFile file = sd.open("/index.bin", O_RDWR);
                if (file) {
                    SessionIndexEntry entry;
                    bool deletedSomething = false;
                    uint32_t pos = 0;
                    
                    while (file.read((uint8_t*)&entry, sizeof(SessionIndexEntry)) == sizeof(SessionIndexEntry)) {
                        if (entry.status == 0x01) {
                            sd.remove(entry.filepath);
                            
                            entry.status = 0x00; // DELETED
                            file.seekSet(pos);
                            file.write((const uint8_t*)&entry, sizeof(SessionIndexEntry));
                            deletedSomething = true;
                            break; // Delete one per iteration to avoid hogging CPU
                        }
                        pos += sizeof(SessionIndexEntry);
                    }
                    file.close();
                    xSemaphoreGive(sdMutex);
                    xSemaphoreGive(indexMutex);
                    
                    if (!deletedSomething) break; 
                } else {
                    xSemaphoreGive(sdMutex);
                    xSemaphoreGive(indexMutex);
                    break;
                }
            } else {
                xSemaphoreGive(indexMutex);
                break;
            }
        }
    }
}

void SDManager::compactIndex() {
    if (xSemaphoreTake(indexMutex, portMAX_DELAY) == pdTRUE) {
        if (xSemaphoreTake(sdMutex, portMAX_DELAY) == pdTRUE) {
            FsFile oldFile = sd.open("/index.bin", O_READ);
            if (oldFile) {
                FsFile newFile = sd.open("/index.tmp", O_WRITE | O_CREAT | O_TRUNC);
                if (newFile) {
                    SessionIndexEntry entry;
                    while (oldFile.read((uint8_t*)&entry, sizeof(SessionIndexEntry)) == sizeof(SessionIndexEntry)) {
                        if (entry.status == 0x01) {
                            newFile.write((const uint8_t*)&entry, sizeof(SessionIndexEntry));
                        }
                    }
                    newFile.close();
                }
                oldFile.close();
                
                sd.remove("/index.bin");
                sd.rename("/index.tmp", "/index.bin");
            }
            xSemaphoreGive(sdMutex);
        }
        xSemaphoreGive(indexMutex);
    }
}

size_t SDManager::getTotalBytes() {
    if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        size_t total = sd.card()->sectorCount() * 512;
        xSemaphoreGive(sdMutex);
        return total;
    }
    return 0;
}

size_t SDManager::getFreeBytes() {
    static size_t cachedFree = 0;
    static unsigned long lastCheck = 0;
    
    // Only calculate free space every 10 minutes (600000 ms) because freeClusterCount() 
    // scans the FAT table and can block the CPU for several seconds, causing MPU FIFO overflow!
    if (cachedFree == 0 || millis() - lastCheck > 600000) {
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
            cachedFree = sd.vol()->freeClusterCount() * sd.vol()->sectorsPerCluster() * 512;
            xSemaphoreGive(sdMutex);
            lastCheck = millis();
        }
    }
    return cachedFree;
}
