#ifndef SD_MANAGER_H
#define SD_MANAGER_H

#include <Arduino.h>
#include <SD.h>
#include <SPI.h>
#include "Config.h"

class SDManager {
public:
    SDManager();
    ~SDManager();

    // Initialize the SD card
    bool init();

    // Check if SD is currently available
    bool isAvailable() const { return available; }

private:
    bool available;
};

extern SDManager sdManager;

#endif // SD_MANAGER_H
