#ifndef WIFI_MANAGER_MODULE_H
#define WIFI_MANAGER_MODULE_H

#include <Arduino.h>
#include <WiFi.h>
#include "Config.h"

class WiFiManagerModule {
public:
    WiFiManagerModule();
    
    bool init();
    int getConnectedClientsCount() const;

private:
    IPAddress apIP;
};

#endif // WIFI_MANAGER_MODULE_H
