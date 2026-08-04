#include "SDManager.h"

SDManager sdManager;

SDManager::SDManager() {
    available = false;
}

SDManager::~SDManager() {
    if (available) {
        SD.end();
    }
}

bool SDManager::init() {
    Serial.println("[SDManager] Initializing SD Card...");
    
    if (SD.begin(SD_CS_PIN)) {
        Serial.println("[SDManager] SD Card mounted successfully.");
        available = true;
    } else {
        Serial.println("[SDManager] SD Card not found or mount failed.");
        available = false;
    }
    
    return available;
}
