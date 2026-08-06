#include "WebServerModule.h"
#include <LittleFS.h>
#include "DatabaseManager.h"
#include "DatabaseManager.h"
#include <ElegantOTA.h>
#include "SystemCommands.h"

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
    ElegantOTA.begin(&server);
    server.begin();
    Serial.println("[WebServer] HTTP Server started successfully on port 80!");
}

class AsyncChunkedSessionsResponse : public AsyncAbstractResponse {
private:
    sqlite3_stmt* _stmt;
    bool _isFirstRow;
    bool _isDone;

public:
    AsyncChunkedSessionsResponse(sqlite3_stmt* stmt) : _stmt(stmt), _isFirstRow(true), _isDone(false) {
        _code = 200;
        _contentType = "application/json";
        _sendContentLength = false;
        _chunked = true;
    }

    ~AsyncChunkedSessionsResponse() {
        if (_stmt) {
            sqlite3_finalize(_stmt);
            _stmt = nullptr;
        }
    }

    bool _sourceValid() const override {
        return _stmt != nullptr;
    }

    size_t _fillBuffer(uint8_t *buf, size_t maxLen) override {
        if (_isDone || !_stmt) return 0;

        size_t written = 0;
        
        if (_isFirstRow) {
            buf[written++] = '[';
        }

        // Leave 250 bytes margin to fit a serialized row safely
        while (written < maxLen - 250) {
            int rc = sqlite3_step(_stmt);
            
            if (rc == SQLITE_ROW) {
                if (!_isFirstRow) {
                    buf[written++] = ',';
                }
                _isFirstRow = false;
                
                JsonDocument doc;
                doc["patientId"] = sqlite3_column_text(_stmt, 0) ? (const char*)sqlite3_column_text(_stmt, 0) : "";
                doc["timestamp"] = sqlite3_column_int(_stmt, 1);
                doc["dateStr"] = sqlite3_column_text(_stmt, 2) ? (const char*)sqlite3_column_text(_stmt, 2) : "";
                doc["minAngle"] = sqlite3_column_double(_stmt, 3);
                doc["maxAngle"] = sqlite3_column_double(_stmt, 4);
                doc["amplitude"] = sqlite3_column_double(_stmt, 5);
                doc["avgSpeed"] = sqlite3_column_double(_stmt, 6);
                doc["smoothness"] = sqlite3_column_double(_stmt, 7);
                doc["flexionsCount"] = sqlite3_column_int(_stmt, 8);
                doc["sessionDuration"] = sqlite3_column_double(_stmt, 9);
                
                written += serializeJson(doc, buf + written, maxLen - written);
                
            } else if (rc == SQLITE_DONE) {
                buf[written++] = ']';
                _isDone = true;
                break;
            } else {
                Serial.printf("[WebServer] SQLite step error: %d\n", rc);
                if (_isFirstRow) {
                    buf[written++] = '[';
                }
                buf[written++] = ']';
                _isDone = true;
                break;
            }
        }
        
        return written;
    }
};

void WebServerModule::setupRoutes() {
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
        bool active = analytics->isSessionActive();
        SessionRecord rec = analytics->getCurrentRecord();
        MPUData mpu = sensor->getData();
        
        JsonDocument doc;
        doc["type"] = "status";
        doc["connectedClients"] = wifi->getConnectedClientsCount();
        doc["usedBytes"] = 0;
        doc["totalBytes"] = 0;
        doc["sessionActive"] = active;
        doc["patientId"] = rec.patientId;
        doc["angle"] = serialized(String(mpu.roll, 2));
        doc["sdAvailable"] = dbManager.isSDAvailable();
        
        String response;
        serializeJson(doc, response);
        Serial.printf("[WebServer] /api/status requested. Free heap: %u\n", ESP.getFreeHeap());
        request->send(200, "application/json", response);
    });

    server.on("/api/sessions", HTTP_GET, [](AsyncWebServerRequest *request) {
        int limit = request->hasArg("limit") ? request->arg("limit").toInt() : 50;
        int offset = request->hasArg("offset") ? request->arg("offset").toInt() : 0;
        
        sqlite3_stmt* stmt = dbManager.prepareSessionsQuery(limit, offset);
        if (!stmt) {
            request->send(500, "application/json", "{\"error\":\"Failed to prepare statement\"}");
            return;
        }
        
        AsyncChunkedSessionsResponse* response = new AsyncChunkedSessionsResponse(stmt);
        request->send(response);
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
                SysCommandMsg msg = {};
                msg.cmd = CMD_START_SESSION;
                strncpy(msg.patientId, request->arg("patientId").c_str(), sizeof(msg.patientId) - 1);
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "stopSession") {
            SysCommandMsg msg = {};
            msg.cmd = CMD_STOP_SESSION;
            xQueueSend(sysCommandQueue, &msg, 0);
        } else if (action == "recalibrate") {
            SysCommandMsg msg = {};
            msg.cmd = CMD_RECALIBRATE;
            xQueueSend(sysCommandQueue, &msg, 0);
        } else if (action == "reboot") {
            request->send(200, "application/json", "{\"ok\":true}");
            delay(500);
            ESP.restart();
            return;
        }
        request->send(200, "application/json", "{\"ok\":true}");
    });


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
        request->send(404, "text/plain", "404: Not Found");
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
        SysCommandMsg msg = {};
        msg.cmd = CMD_START_SESSION;
        strncpy(msg.patientId, doc["patientId"].as<const char*>(), sizeof(msg.patientId) - 1);
        xQueueSend(sysCommandQueue, &msg, 0);
    } else if (cmd == "stopSession") {
        SysCommandMsg msg = {};
        msg.cmd = CMD_STOP_SESSION;
        xQueueSend(sysCommandQueue, &msg, 0);
    } else if (cmd == "recalibrate") {
        SysCommandMsg msg = {};
        msg.cmd = CMD_RECALIBRATE;
        xQueueSend(sysCommandQueue, &msg, 0);
    }
}

void WebServerModule::broadcastAngle(float angle) {
    if (ws.count() == 0) return;

    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"angle\",\"angle\":%.2f}", angle);
    
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(buf);
        }
    }
}

void WebServerModule::broadcastStatus() {
    unsigned long now = millis();
    if (now - lastStatusBroadcastMs < STATUS_UPDATE_INTERVAL_MS && lastStatusBroadcastMs != 0) return;
    lastStatusBroadcastMs = now;
    if (ws.count() == 0) return;

    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();
    
    JsonDocument doc;
    doc["type"] = "status";
    doc["connectedClients"] = wifi->getConnectedClientsCount();
    doc["usedBytes"] = 0;
    doc["totalBytes"] = 0;
    doc["sessionActive"] = active;
    doc["patientId"] = rec.patientId;
    doc["sdAvailable"] = dbManager.isSDAvailable();
    doc["version"] = FIRMWARE_VERSION;
    
    String buf;
    serializeJson(doc, buf);
             
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(buf);
        }
    }
}

void WebServerModule::broadcastLiveStats() {
    if (ws.count() == 0) return;
    unsigned long now = millis();
    if (now - lastStatsBroadcastMs < 200) return;
    lastStatsBroadcastMs = now;

    String liveJson = analytics->getLiveStatsJSON();
    liveJson.replace("{\"active\"", "{\"type\":\"liveStats\",\"active\"");
    
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(liveJson);
        }
    }
}

void WebServerModule::update() {
    // ElegantOTA.loop(); // Temporarily disabled for debugging

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
    
    JsonDocument doc;
    doc["type"] = "status";
    doc["connectedClients"] = wifi->getConnectedClientsCount();
    doc["usedBytes"] = 0;
    doc["totalBytes"] = 0;
    doc["sessionActive"] = active;
    doc["patientId"] = rec.patientId;
    doc["sdAvailable"] = dbManager.isSDAvailable();
    doc["version"] = FIRMWARE_VERSION;
    
    String buf;
    serializeJson(doc, buf);
    client->text(buf);
}


void WebServerModule::cleanupClients() {
    unsigned long now = millis();
    if (now - lastCleanupMs < 2000 && lastCleanupMs != 0) return;
    lastCleanupMs = now;
    ws.cleanupClients();
}
