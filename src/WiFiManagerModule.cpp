#include "WiFiManagerModule.h"
#include "esp_netif.h"
#include <ESPmDNS.h>

WiFiManagerModule::WiFiManagerModule() : apIP(192, 168, 4, 1) {}

bool WiFiManagerModule::init() {
    Serial.println("[WiFiManager] Configuring Wi-Fi in SoftAP mode...");
    
    WiFi.mode(WIFI_AP);
    
    if (!WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0))) {
        Serial.println("[WiFiManager] Error setting IP configuration for Access Point!");
        return false;
    }

    if (!WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD, WIFI_AP_CHANNEL, 0, WIFI_AP_MAX_CONNECTIONS)) {
        Serial.println("[WiFiManager] Error starting WiFi SoftAP!");
        return false;
    }

    // Disable DHCP options 3 (Router) and 6 (DNS)
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (netif) {
        esp_netif_dhcps_stop(netif);
        uint8_t opt_val = 0; // Disable
        // In ESP-IDF v4, the router option (Option 3) is controlled by ESP_NETIF_ROUTER_SOLICITATION_ADDRESS (Option 32)
        // due to a quirk in the API design.
        esp_netif_dhcps_option(netif, ESP_NETIF_OP_SET, ESP_NETIF_ROUTER_SOLICITATION_ADDRESS, &opt_val, sizeof(opt_val));
        esp_netif_dhcps_option(netif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &opt_val, sizeof(opt_val));
        esp_netif_dhcps_start(netif);
        Serial.println("[WiFiManager] Disabled DHCP options 3 (Router) and 6 (DNS) on SoftAP.");
    }

    // Initialize mDNS to allow access via rehab.local
    if (!MDNS.begin("rehab")) {
        Serial.println("[WiFiManager] Error setting up MDNS responder!");
    } else {
        Serial.println("[WiFiManager] mDNS responder started at rehab.local");
        // Add HTTP service to mDNS
        MDNS.addService("http", "tcp", WEB_SERVER_PORT);
    }

    Serial.printf("[WiFiManager] SoftAP started successfully!\n");
    Serial.printf("             SSID: %s\n", WIFI_AP_SSID);
    Serial.printf("             Password: %s\n", WIFI_AP_PASSWORD);
    Serial.printf("             IP: %s\n", WiFi.softAPIP().toString().c_str());

    return true;
}

int WiFiManagerModule::getConnectedClientsCount() const {
    return WiFi.softAPgetStationNum();
}

