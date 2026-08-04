#include "WebServerModule.h"
#include <LittleFS.h>
#include "DatabaseManager.h"
#include <ElegantOTA.h>

// Fallback embedded HTML interface
static const char FALLBACK_HTML[] = R"rawliteral(
<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>RehabDevice Error</title>
<style>body{background:#0a0e17;color:#fff;font-family:sans-serif;text-align:center;padding:50px;}
.box{border:1px solid #ff4c4c;padding:30px;border-radius:16px;max-width:500px;margin:0 auto;}
h1{color:#ff4c4c;}</style></head>
<body><div class="box"><h1>⚠️ Помилка LittleFS</h1>
<p>Системі не вдалося прочитати файли веб-інтерфейсу з пам'яті.</p>
<button onclick="location.reload()" style="padding:10px 20px; background:#ff4c4c; color:#fff; border:none; border-radius:8px; cursor:pointer; margin-top:15px; font-weight:bold;">Оновити сторінку</button>
</div></body></html>
)rawliteral";

WebServerModule::WebServerModule(SensorMPU* sensorPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr)
    : server(WEB_SERVER_PORT), ws("/ws"), sensor(sensorPtr), analytics(analyticsPtr), wifi(wifiPtr),
      lastStatusBroadcastMs(0), lastStatsBroadcastMs(0), lastCleanupMs(0), sendInitialStatusClientId(0) {}

static String getContentType(const String& path) {
    if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".js")) return "application/javascript";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".svg")) return "image/svg+xml";
    return "text/plain";
}

void WebServerModule::init() {
    Serial.println("[WebServer] Initializing Async Web Server and WebSocket...");
    ws.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c, AwsEventType type, void* arg, uint8_t* d, size_t len) {
        this->onWsEvent(s, c, type, arg, d, len);
    });
    server.addHandler(&ws);
    setupRoutes();
    // ElegantOTA.begin(&server); // Temporarily disabled for debugging
    server.begin();
    Serial.println("[WebServer] HTTP Server started successfully on port 80!");
}

void WebServerModule::setupRoutes() {
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
        bool active = analytics->isSessionActive();
        SessionRecord rec = analytics->getCurrentRecord();
        MPUData mpu = sensor->getData();
        char buf[256];
        snprintf(buf, sizeof(buf),
                 "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":0,\"totalBytes\":0,"
                 "\"sessionActive\":%s,\"patientId\":\"%s\",\"angle\":%.2f,\"sdAvailable\":%s}",
                 wifi->getConnectedClientsCount(),
                 active ? "true" : "false", rec.patientId.c_str(), mpu.roll, dbManager.isSDAvailable() ? "true" : "false");
                 
        Serial.printf("[WebServer] /api/status requested. Free heap: %u\n", ESP.getFreeHeap());
        request->send(200, "application/json", buf);
    });

    server.on("/api/sessions", HTTP_GET, [](AsyncWebServerRequest *request) {
        int limit = request->hasArg("limit") ? request->arg("limit").toInt() : 50;
        int offset = request->hasArg("offset") ? request->arg("offset").toInt() : 0;
        request->send(200, "application/json", dbManager.getSessionsJson(limit, offset));
    });

    server.on("/api/cmd", HTTP_GET, [this](AsyncWebServerRequest *request) {
        String action = request->hasArg("action") ? request->arg("action") : "";
        if (action == "syncTime") {
            unsigned long ts = request->arg("timestamp").toInt();
            if (ts > 1000000000UL) {
                struct timeval tv = { .tv_sec = (time_t)ts, .tv_usec = 0 };
                settimeofday(&tv, NULL);
            }
        } else if (action == "startSession") {
            if (request->hasArg("patientId")) {
                pendingPatientId = request->arg("patientId");
                pendingStartSession = true;
            }
        } else if (action == "stopSession") {
            pendingStopSession = true;
        } else if (action == "recalibrate") {
            pendingRecalibrate = true;
        } else if (action == "reboot") {
            request->send(200, "application/json", "{\"ok\":true}");
            delay(500);
            ESP.restart();
            return;
        }
        request->send(200, "application/json", "{\"ok\":true}");
    });

    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest *request) { request->redirect("http://192.168.4.1/"); });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest *request) { request->redirect("http://192.168.4.1/"); });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest *request) { request->redirect("http://192.168.4.1/"); });

    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
    server.serveStatic("/games", LittleFS, "/games/");
    
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!LittleFS.exists("/index.html")) {
            request->send(200, "text/html", FALLBACK_HTML);
        }
    });

    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_GET) {
            String path = request->url();
            if (LittleFS.exists(path)) {
                request->send(LittleFS, path, getContentType(path));
                return;
            }
        }
        String url = request->url();
        bool isApiOrFile = url.startsWith("/api/") || url.endsWith(".js") || url.endsWith(".css") || url.endsWith(".json");
        if (!isApiOrFile && !request->host().equalsIgnoreCase(WiFi.softAPIP().toString())) {
            request->redirect("http://" + WiFi.softAPIP().toString() + "/");
        } else {
            request->send(404, "text/plain", "404: Not Found");
        }
    });
}

void WebServerModule::onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type, void* arg, uint8_t* data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WebServer] WebSocket client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
        sendInitialStatusClientId = client->id();
    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WebServer] WebSocket client #%u disconnected\n", client->id());
    } else if (type == WS_EVT_DATA) {
        handleWebSocketMessage(client, data, len);
    }
}

void WebServerModule::handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len) {
    JsonDocument doc;
    if (deserializeJson(doc, data, len)) return;
    String cmd = doc["cmd"].as<String>();

    if (cmd == "syncTime") {
        unsigned long unixTime = doc["timestamp"].as<unsigned long>();
        if (unixTime > 1000000000UL) {
            struct timeval tv = { .tv_sec = (time_t)unixTime, .tv_usec = 0 };
            settimeofday(&tv, NULL);
        }
    } else if (cmd == "startSession") {
        pendingPatientId = doc["patientId"].as<String>();
        pendingStartSession = true;
    } else if (cmd == "stopSession") {
        pendingStopSession = true;
    } else if (cmd == "recalibrate") {
        pendingRecalibrate = true;
    } else if (cmd == "getSessions") {
        int limit = doc["limit"].is<int>() ? doc["limit"].as<int>() : 50;
        int offset = doc["offset"].is<int>() ? doc["offset"].as<int>() : 0;
        String sessionsJson = dbManager.getSessionsJson(limit, offset);
        client->text("{\"type\":\"sessionsList\",\"sessions\":" + sessionsJson + "}");
    }
}

void WebServerModule::broadcastAngle(float angle) {
    if (ws.count() == 0) return;
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"angle\",\"angle\":%.2f}", angle);
    ws.textAll(buf);
}

void WebServerModule::broadcastStatus() {
    unsigned long now = millis();
    if (now - lastStatusBroadcastMs < STATUS_UPDATE_INTERVAL_MS && lastStatusBroadcastMs != 0) return;
    lastStatusBroadcastMs = now;
    if (ws.count() == 0) return;

    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();
    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":0,\"totalBytes\":0,\"sessionActive\":%s,\"patientId\":\"%s\",\"sdAvailable\":%s}",
             wifi->getConnectedClientsCount(), active ? "true" : "false", rec.patientId.c_str(), dbManager.isSDAvailable() ? "true" : "false");
    ws.textAll(buf);
}

void WebServerModule::broadcastLiveStats() {
    if (ws.count() == 0) return;
    unsigned long now = millis();
    if (now - lastStatsBroadcastMs < 200) return;
    lastStatsBroadcastMs = now;

    String liveJson = analytics->getLiveStatsJSON();
    liveJson.replace("{\"active\"", "{\"type\":\"liveStats\",\"active\"");
    ws.textAll(liveJson);
}

void WebServerModule::update() {
    // ElegantOTA.loop(); // Temporarily disabled for debugging

    if (pendingStartSession) {
        analytics->startSession(pendingPatientId);
        broadcastStatus();
        pendingStartSession = false;
    }
    if (pendingStopSession) {
        SessionRecord rec = analytics->getCurrentRecord();
        analytics->stopSession();
        dbManager.saveSession(rec);
        broadcastStatus();
        pendingStopSession = false;
    }
    if (pendingRecalibrate) {
        sensor->recalibrate();
        pendingRecalibrate = false;
    }

    if (sendInitialStatusClientId != 0) {
        AsyncWebSocketClient* client = ws.client(sendInitialStatusClientId);
        if (client && client->status() == WS_CONNECTED && client->canSend()) {
            sendStatusToClient(client);
            sendInitialStatusClientId = 0;
        } else if (!client || client->status() != WS_CONNECTED) {
            sendInitialStatusClientId = 0;
        }
    }
}

void WebServerModule::sendStatusToClient(AsyncWebSocketClient* client) {
    if (!client || client->status() != WS_CONNECTED) return;
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();
    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":0,\"totalBytes\":0,\"sessionActive\":%s,\"patientId\":\"%s\",\"sdAvailable\":%s}",
             wifi->getConnectedClientsCount(), active ? "true" : "false", rec.patientId.c_str(), dbManager.isSDAvailable() ? "true" : "false");
    client->text(buf);
}

void WebServerModule::cleanupClients() {
    unsigned long now = millis();
    if (now - lastCleanupMs < 2000 && lastCleanupMs != 0) return;
    lastCleanupMs = now;
    ws.cleanupClients();
}
