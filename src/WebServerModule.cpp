#include "WebServerModule.h"

// Fallback embedded HTML interface (in case SD card fails or is missing files)
static const char FALLBACK_HTML[] = R"rawliteral(
<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>RehabDevice Error</title>
<style>body{background:#0a0e17;color:#fff;font-family:sans-serif;text-align:center;padding:50px;}
.box{border:1px solid #ff4c4c;padding:30px;border-radius:16px;max-width:500px;margin:0 auto;}
h1{color:#ff4c4c;}</style></head>
<body><div class="box"><h1>⚠️ Помилка SD-карти</h1>
<p>Системі не вдалося прочитати файли веб-інтерфейсу з SD-карти.</p>
<p>Можливі причини:</p>
<ul style="text-align:left; color:#ccc;">
<li>SD-карта не вставлена або відійшли контакти</li>
<li>Файли <b>index.html</b>, <b>style.css</b> та <b>app.js</b> відсутні в корені карти</li>
<li>Апаратний збій читання (можливі проблеми з живленням або проводами)</li>
</ul>
<button onclick="location.reload()" style="padding:10px 20px; background:#ff4c4c; color:#fff; border:none; border-radius:8px; cursor:pointer; margin-top:15px; font-weight:bold;">Оновити сторінку</button>
</div></body></html>
)rawliteral";

WebServerModule::WebServerModule(SensorMPU* sensorPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr)
    : server(WEB_SERVER_PORT), ws("/ws"), sensor(sensorPtr), analytics(analyticsPtr), wifi(wifiPtr),
      lastStatusBroadcastMs(0), lastStatsBroadcastMs(0), lastCleanupMs(0), sendInitialStatusClientId(0) {}

class SdFatResponse : public AsyncAbstractResponse {
private:
    FsFile _file;
    bool _valid;
public:
    SdFatResponse(const char* path, const char* contentType) {
        _code = 200;
        _contentType = contentType;
        _valid = false;
        
        const char* filepath = (path[0] == '/') ? (path + 1) : path;
        
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1500)) == pdTRUE) {
            _file = sd.open(filepath, O_READ);
            if (_file.isOpen()) {
                if (!_file.isDirectory()) {
                    _contentLength = _file.size();
                    _valid = true;
                    Serial.printf("[WebServer] Opened: '%s', Size: %u\n", filepath, (unsigned int)_contentLength);
                } else {
                    _contentLength = 0;
                    _code = 404;
                    Serial.printf("[WebServer] Path is a directory: '%s'\n", filepath);
                    _file.close();
                }
            } else {
                _contentLength = 0;
                _code = 404;
                Serial.printf("[WebServer] Failed to open: '%s'\n", filepath);
                SDManager::checkHealth();
            }
            xSemaphoreGive(sdMutex);
        } else {
            Serial.printf("[WebServer] TIMEOUT waiting for sdMutex for file '%s'\n", filepath);
        }
    }
    
    ~SdFatResponse() {
        if (_file.isOpen()) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                _file.close();
                xSemaphoreGive(sdMutex);
            }
        }
    }
    
    bool _sourceValid() const override { return _valid; }
    
    virtual size_t _fillBuffer(uint8_t *buf, size_t maxLen) override {
        size_t bytesRead = 0;
        if (!_file.isOpen()) return 0;
        
        size_t sendSize = maxLen > 2048 ? 2048 : maxLen;
        
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
            int readResult = _file.read(buf, sendSize);
            if (readResult < 0) {
                Serial.println("[WebServer] Read error during chunk transfer");
                SDManager::checkHealth();
            } else {
                bytesRead = readResult;
            }
            xSemaphoreGive(sdMutex);
            vTaskDelay(1); // Yield for stability
        }
        return bytesRead;
    }
};

static String getContentType(const String& path) {
    if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".js")) return "application/javascript";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".ico")) return "image/x-icon";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".woff")) return "font/woff";
    if (path.endsWith(".woff2")) return "font/woff2";
    if (path.endsWith(".ttf")) return "font/ttf";
    return "text/plain";
}

static bool ensureSDReady(AsyncWebServerRequest *request) {
    SDManager::checkHealth();
    if (!SDManager::isReady()) {
        if (request->url() == "/" || request->url() == "/index.html") {
            request->send(503, "text/html", FALLBACK_HTML);
        } else {
            request->send(503, "text/plain", "503: Storage Unavailable");
        }
        return false;
    }
    return true;
}

static bool serveStaticFile(AsyncWebServerRequest *request, const char* path, const char* contentType) {
    if (!ensureSDReady(request)) return true; // 503 sent

    SdFatResponse *response = new SdFatResponse(path, contentType);
    if (!response->_sourceValid()) {
        delete response;
        if (!SDManager::isReady()) {
            ensureSDReady(request); // Send 503
            return true;
        }
        return false; // SD healthy, file just missing
    }
    
    request->send(response);
    return true;
}

static void sendFileChunked(AsyncWebServerRequest *request, const char* path, const char* contentType) {
    if (!serveStaticFile(request, path, contentType)) {
        request->send(404, "text/plain", "404: File not found");
    }
}


void WebServerModule::init() {
    Serial.println("[WebServer] Initializing Async Web Server and WebSocket...");

    Serial.println("[WebServer] Skipping RAM caching to save heap memory.");

    ws.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c, AwsEventType type, void* arg, uint8_t* d, size_t len) {
        this->onWsEvent(s, c, type, arg, d, len);
    });
    server.addHandler(&ws);

    setupRoutes();

    server.begin();
    Serial.println("[WebServer] HTTP Server started successfully on port 80!");
}

void WebServerModule::setupRoutes() {
    auto serveIndex = [this](AsyncWebServerRequest *request) {
        Serial.printf("[HTTP] GET %s from %s Host: %s\n", request->url().c_str(), request->client()->remoteIP().toString().c_str(), request->host().c_str());
        if (!serveStaticFile(request, "index.html", "text/html")) {
            // File not found on a healthy SD card
            request->send(404, "text/html", FALLBACK_HTML);
        }
    };
    server.on("/", HTTP_GET, serveIndex);
    server.on("/index.html", HTTP_GET, serveIndex);

    server.on("/style.css", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /style.css");
        sendFileChunked(request, "style.css", "text/css");
    });

    server.on("/app.js", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /app.js");
        sendFileChunked(request, "app.js", "application/javascript");
    });

    // Маршрут для раздачи статических файлов игр из папки /games/
    // TODO: server.serveStatic("/games", SD, "/games/"); // Not supported natively by SdFat + ESPAsyncWebServer without wrapper

    server.on("/api/download_bin", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /api/download_bin");
        String id = request->hasArg("id") ? request->arg("id") : "";
        if (id.length() == 0) {
            request->send(400, "text/plain", "Missing id");
            return;
        }
        
        char path[64];
        SDManager::generateShardedPath(id.c_str(), path, sizeof(path));
        sendFileChunked(request, path, "application/octet-stream");
    });

    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /api/status");
        size_t total = SDManager::getTotalBytes();
        size_t used = total - SDManager::getFreeBytes();
        bool active = analytics->isSessionActive();
        SessionRecord rec = analytics->getCurrentRecord();
        MPUData mpu = sensor->getData();

        char buf[384];
        snprintf(buf, sizeof(buf),
                 "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,"
                 "\"sessionActive\":%s,\"patientId\":\"%s\",\"angle\":%.2f}",
                 wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
                 active ? "true" : "false", rec.patientId.c_str(), mpu.roll);
        request->send(200, "application/json", buf);
    });

    server.on("/api/sessions", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /api/sessions");
        
        int page = request->hasArg("page") ? request->arg("page").toInt() : 0;
        int limit = request->hasArg("limit") ? request->arg("limit").toInt() : 20;
        
        if (xSemaphoreTake(indexMutex, pdMS_TO_TICKS(500)) != pdTRUE) {
            request->send(503, "application/json", "{\"error\":\"Index busy\"}");
            return;
        }
        
        uint32_t totalRecords = 0;
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
            FsFile file = sd.open("/index.bin", O_READ);
            if (file) {
                totalRecords = file.size() / sizeof(SessionIndexEntry);
                file.close();
            }
            xSemaphoreGive(sdMutex);
        }
        xSemaphoreGive(indexMutex);
        
        if (totalRecords == 0) {
            request->send(200, "application/json", "[]");
            return;
        }
        
        int startIdx = (int)totalRecords - 1 - (page * limit);
        if (startIdx < 0) startIdx = -1;
        
        int recordsToSend = (startIdx + 1 > limit) ? limit : (startIdx + 1);
        
        if (recordsToSend <= 0) {
            request->send(200, "application/json", "[]");
            return;
        }
        
        struct SessionStreamState {
            int currentIdx;
            int remaining;
            bool isFirst;
        };
        SessionStreamState* state = new SessionStreamState{startIdx, recordsToSend, true};
        
        AsyncWebServerResponse *response = request->beginChunkedResponse("application/json",
        [state](uint8_t *buffer, size_t maxLen, size_t index) -> size_t {
            if (state->remaining <= 0) {
                if (state->currentIdx == -2) {
                    delete state;
                    return 0;
                }
                buffer[0] = ']';
                state->currentIdx = -2;
                return 1;
            }
            
            size_t bytesWritten = 0;
            if (state->isFirst) {
                buffer[bytesWritten++] = '[';
                state->isFirst = false;
            } else {
                buffer[bytesWritten++] = ',';
            }
            
            SessionIndexEntry entry;
            bool readOk = false;
            if (xSemaphoreTake(indexMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    FsFile file = sd.open("/index.bin", O_READ);
                    if (file) {
                        file.seekSet(state->currentIdx * sizeof(SessionIndexEntry));
                        if (file.read((uint8_t*)&entry, sizeof(SessionIndexEntry)) == sizeof(SessionIndexEntry)) {
                            readOk = true;
                        }
                        file.close();
                    }
                    xSemaphoreGive(sdMutex);
                }
                xSemaphoreGive(indexMutex);
            }
            
            vTaskDelay(1); // Yield
            
            if (readOk && entry.status == 0x01) {
                char jsonBuf[256];
                int len = snprintf(jsonBuf, sizeof(jsonBuf), 
                    "{\"patientId\":\"%s\",\"timestamp\":%lu,\"minAngle\":%.1f,\"maxAngle\":%.1f,\"amplitude\":%.1f,\"avgSpeed\":%.1f,\"smoothness\":%.1f,\"flexionsCount\":%ld,\"holdingTime\":%.1f}",
                    entry.patientId, entry.timestamp, entry.minAngle, entry.maxAngle, entry.amplitude, 
                    entry.avgSpeed, entry.smoothness, (long)entry.flexionsCount, entry.holdingTime);
                if (bytesWritten + len <= maxLen) {
                    memcpy(buffer + bytesWritten, jsonBuf, len);
                    bytesWritten += len;
                }
            } else if (!readOk) {
                bytesWritten--; 
            } else if (entry.status == 0x00) {
                memcpy(buffer + bytesWritten, "{}", 2); // Send empty object for deleted records
                bytesWritten += 2;
            }
            
            state->currentIdx--;
            state->remaining--;
            return bytesWritten;
        });
        request->send(response);
    });

    server.on("/api/cmd", HTTP_GET, [this](AsyncWebServerRequest *request) {
        String action = request->hasArg("action") ? request->arg("action") : "";
        Serial.printf("[HTTP] GET /api/cmd?action=%s\n", action.c_str());

        if (action == "syncTime") {
            unsigned long ts = request->arg("timestamp").toInt();
            if (ts > 1000000000UL) {
                struct timeval tv = { .tv_sec = (time_t)ts, .tv_usec = 0 };
                settimeofday(&tv, NULL);
            }
        } else if (action == "startSession") {
            String patientId = request->hasArg("patientId") ? request->arg("patientId") : "";
            if (patientId.length() > 0) {
                analytics->startSession(patientId);
            }
        } else if (action == "stopSession") {
            analytics->stopSession();
        } else if (action == "recalibrate") {
            sensor->recalibrate();
        } else if (action == "deleteSession") {
            // TODO: Implement delete on SDManager
        } else if (action == "deletePatient") {
            // TODO: Implement deletePatient on SDManager
        }

        request->send(200, "application/json", "{\"ok\":true}");
    });

    // Captive Portal redirection routes (Android / iOS / Windows)
    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /generate_204 (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /fwlink (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /hotspot-detect.html (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });

    // 404 handler with automatic redirection to Captive Portal or static file serving
    server.onNotFound([](AsyncWebServerRequest *request) {
        Serial.printf("[HTTP] 404/redirect handler: %s %s Host: %s\n", request->methodToString(), request->url().c_str(), request->host().c_str());
        
        // 1. Try to serve static files from SD card
        if (request->method() == HTTP_GET) {
            String path = request->url();
            String contentType = getContentType(path);
            if (serveStaticFile(request, path.c_str(), contentType.c_str())) {
                return; // Response already sent (200 OK or 503 Error)
            }
        }

        // 2. If not found on SD, do the Captive Portal redirect ONLY if it's a page request
        String url = request->url();
        bool isApiOrFile = url.startsWith("/api/") || url.endsWith(".js") || url.endsWith(".css") || url.endsWith(".json");
        
        if (!isApiOrFile && !request->host().equalsIgnoreCase(WiFi.softAPIP().toString())) {
            request->redirect("http://" + WiFi.softAPIP().toString() + "/");
        } else {
            request->send(404, "text/plain", "404: Not Found");
        }
    });
}

void WebServerModule::onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                                void* arg, uint8_t* data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WebSocket] Client #%u connected from IP: %s\n", client->id(), client->remoteIP().toString().c_str());
        sendInitialStatusClientId = client->id();
    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WebSocket] Client #%u disconnected\n", client->id());
    } else if (type == WS_EVT_DATA) {
        handleWebSocketMessage(client, data, len);
    }
}

void WebServerModule::handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len) {
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, data, len);
    if (error) {
        Serial.println("[WebSocket] Error parsing incoming JSON");
        return;
    }

    String cmd = doc["cmd"].as<String>();

    if (cmd == "syncTime") {
        unsigned long unixTime = doc["timestamp"].as<unsigned long>();
        if (unixTime > 1000000000UL) {
            struct timeval tv = { .tv_sec = (time_t)unixTime, .tv_usec = 0 };
            settimeofday(&tv, NULL);
            Serial.printf("[WebServer] Time synchronized via WebSocket: %lu\n", unixTime);
        }
    } else if (cmd == "startSession") {
        pendingPatientId = doc["patientId"].as<String>();
        pendingStartSession = true;
    } else if (cmd == "stopSession") {
        pendingStopSession = true;
    } else if (cmd == "recalibrate") {
        sensor->recalibrate();
    } else if (cmd == "getSessions") {
        // TODO: Send Sessions List via SDManager
    } else if (cmd == "deleteSession") {
        // TODO
    } else if (cmd == "deletePatient") {
        // TODO
    } else if (cmd == "rebuildIndex") {
        // TODO
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

    size_t total = SDManager::getTotalBytes();
    size_t used = total - SDManager::getFreeBytes();
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();

    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,\"sessionActive\":%s,\"patientId\":\"%s\"}",
             wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
             active ? "true" : "false", rec.patientId.c_str());
    ws.textAll(buf);
}

void WebServerModule::broadcastLiveStats() {
    if (ws.count() == 0) return;

    unsigned long now = millis();
    if (now - lastStatsBroadcastMs < 200) return; // Update live stats 5 times per second
    lastStatsBroadcastMs = now;

    String liveJson = analytics->getLiveStatsJSON();
    liveJson.replace("{\"active\"", "{\"type\":\"liveStats\",\"active\"");
    ws.textAll(liveJson);
}

void WebServerModule::sendSessionsList(AsyncWebSocketClient* client) {
    if (ws.count() == 0 && !client) return;
    streamState.active = true;
    streamState.clientId = client ? client->id() : 0;
    streamState.headerSent = false;
    streamState.currentPatientIdx = 0;
}

void WebServerModule::update() {
    // Process pending session commands (deferred from WebSocket to avoid AsyncTCP blocks)
    if (pendingStartSession) {
        analytics->startSession(pendingPatientId);
        broadcastStatus();
        pendingStartSession = false;
    }
    if (pendingStopSession) {
        analytics->stopSession();
        broadcastStatus();
        pendingStopSession = false;
    }

    // 1. Send initial status to newly connected client from Core 1
    if (sendInitialStatusClientId != 0) {
        AsyncWebSocketClient* client = ws.client(sendInitialStatusClientId);
        if (client && client->status() == WS_CONNECTED) {
            if (client->canSend()) {
                sendStatusToClient(client);
                sendInitialStatusClientId = 0;
            }
        } else {
            sendInitialStatusClientId = 0;
        }
    }

    // 2. Step-by-step non-blocking streaming of patient sessions (one chunk per loop)
    if (!streamState.active) return;

    AsyncWebSocketClient* client = nullptr;
    if (streamState.clientId != 0) {
        client = ws.client(streamState.clientId);
        if (!client || client->status() != WS_CONNECTED) {
            streamState.active = false;
            return;
        }
        if (!client->canSend()) {
            return;
        }
    }

    if (!streamState.headerSent) {
        char startBuf[128];
        snprintf(startBuf, sizeof(startBuf), "{\"type\":\"sessionsStreamStart\",\"totalPatients\":0}");
        if (client) client->text(startBuf); else ws.textAll(startBuf);
        streamState.headerSent = true;
        streamState.currentPatientIdx = 0;
        return;
    }

    // TODO: Implement SDManager directory iteration for sessions
    char endBuf[128];
    snprintf(endBuf, sizeof(endBuf), "{\"type\":\"sessionsStreamEnd\",\"totalSent\":0}");
    if (client) client->text(endBuf); else ws.textAll(endBuf);
    streamState.active = false;
}

void WebServerModule::sendStatusToClient(AsyncWebSocketClient* client) {
    if (!client || client->status() != WS_CONNECTED) return;

    size_t total = SDManager::getTotalBytes();
    size_t used = total - SDManager::getFreeBytes();
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();

    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,\"sessionActive\":%s,\"patientId\":\"%s\"}",
             wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
             active ? "true" : "false", rec.patientId.c_str());
    client->text(buf);
}

void WebServerModule::cleanupClients() {
    unsigned long now = millis();
    if (now - lastCleanupMs < 2000 && lastCleanupMs != 0) return;
    lastCleanupMs = now;
    ws.cleanupClients();
}

