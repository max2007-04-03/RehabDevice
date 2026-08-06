import re

def fix():
    with open('data/app.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Add global variables
    if 'let usePolling = false;' not in content:
        content = content.replace(
            'let ws = null;',
            'let usePolling = false;\nlet pollTimer = null;\nlet ws = null;'
        )

    # 2. Fix initConnection race condition
    # Currently:
    # setTimeout(() => {
    #     if (!ws || ws.readyState !== WebSocket.OPEN) {
    #         usePolling = true;
    #         if (ws) { try { ws.close(); } catch(e) {} ws = null; }
    #         if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
    #         startHttpPolling();
    #     }
    # }, 3000);
    
    init_conn_target = """    setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            usePolling = true;
            if (ws) { try { ws.close(); } catch(e) {} ws = null; }
            if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
            startHttpPolling();
        }
    }, 3000);"""
    
    init_conn_replace = """    setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            usePolling = true;
            if (ws) { 
                ws.onclose = null; // PREVENT RACE CONDITION
                try { ws.close(); } catch(e) {} 
                ws = null; 
            }
            if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
            startHttpPolling();
        }
    }, 3000);"""
    content = content.replace(init_conn_target, init_conn_replace)

    # 3. Fix ws.onclose loop
    # Currently:
    #     ws.onclose = () => {
    #         console.log("WebSocket onclose fired!");
    #         usePolling = true;
    #         document.getElementById("statusDot").classList.remove("connected");
    #         ...
    
    onclose_target = """    ws.onclose = () => {
        console.log("WebSocket onclose fired!");
        usePolling = true;
        document.getElementById("statusDot").classList.remove("connected");
        document.getElementById("statusText").textContent = "Відключено (перепідключення...)";
        
        // Retry WebSocket connection every 5 seconds
        if (!reconnectInterval) {
            reconnectInterval = setTimeout(initWebSocket, 5000);
        }
    };"""
    
    onclose_replace = """    ws.onclose = () => {
        console.log("WebSocket onclose fired!");
        if (usePolling) return; // ALREADY IN FALLBACK MODE
        ws = null;
        
        // If HTTP polling is already active, just keep it going
        if (!pollTimer) {
            usePolling = true;
            document.getElementById("statusDot").classList.remove("connected");
            document.getElementById("statusText").textContent = "Відключено (перепідключення...)";
        }
        
        // Retry WebSocket connection every 5 seconds
        if (!reconnectInterval) {
            reconnectInterval = setTimeout(initWebSocket, 5000);
        }
    };"""
    content = content.replace(onclose_target, onclose_replace)
    
    # 3.5 Also fix sendCommand fallback just in case
    # Right now it's:
    # function sendCommand(cmd, params) {
    #     if (ws && ws.readyState === WebSocket.OPEN) {
    #         ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    #     }
    # }
    sendcmd_target = """// Send commands via WebSocket
function sendCommand(cmd, params) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    }
}"""
    sendcmd_replace = """// Send commands via WebSocket
function sendCommand(cmd, params) {
    if (!usePolling && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    } else if (usePolling) {
        let url = `${DEVICE_HOST}/api/cmd?action=${encodeURIComponent(cmd)}`;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
            }
        }
        fetch(url).then(() => {
            setTimeout(pollOnce, 400);
        }).catch(() => {});
    }
}"""
    content = content.replace(sendcmd_target, sendcmd_replace)

    # 4. Implement HTTP fetch in fetchAllSessionsPaginated
    # Currently:
    # function fetchAllSessionsPaginated() {
    #     if (ws && ws.readyState === WebSocket.OPEN) { ... }
    # }
    fetch_target = """function fetchAllSessionsPaginated() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Request in small chunks to prevent ESP32 RAM crash (std::bad_alloc)
        wsSessionsOffset = 0;
        wsSessionsBuffer = [];
        sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
    }
}"""
    fetch_replace = """function fetchAllSessionsPaginated() {
    if (!usePolling && ws && ws.readyState === WebSocket.OPEN) {
        wsSessionsOffset = 0;
        wsSessionsBuffer = [];
        sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
        return;
    }
    
    // HTTP Fallback
    if (usePolling) {
        let all = [];
        let offset = 0;
        const limit = 50;
        
        const loadNextChunk = () => {
            fetch(`${DEVICE_HOST}/api/sessions?offset=${offset}&limit=${limit}`)
                .then(r => r.json())
                .then(data => {
                    if (!Array.isArray(data)) return;
                    all = all.concat(data);
                    if (data.length === limit) {
                        offset += limit;
                        loadNextChunk();
                    } else {
                        handleServerMessage({ type: "sessionsList", sessions: all });
                    }
                }).catch(e => console.error(e));
        };
        loadNextChunk();
    }
}"""
    content = content.replace(fetch_target, fetch_replace)
    
    # 5. Fix sessionsList handleServerMessage
    sessionslist_target = """        if (ws && ws.readyState === WebSocket.OPEN && wsSessionsBuffer !== null) {
            // We are using WebSocket pagination
            wsSessionsBuffer = wsSessionsBuffer.concat(chunk);
            if (chunk.length === 50) {
                // There might be more data, request next chunk
                wsSessionsOffset += 50;
                sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
            } else {
                // Done fetching all chunks
                allSessionsData = wsSessionsBuffer;
                wsSessionsBuffer = null; // free memory reference
                renderPatientPills(allSessionsData);
                updateDoctorDashboardView();
            }
        }"""
        
    sessionslist_replace = """        if (!usePolling && ws && ws.readyState === WebSocket.OPEN && wsSessionsBuffer !== null) {
            // We are using WebSocket pagination
            wsSessionsBuffer = wsSessionsBuffer.concat(chunk);
            if (chunk.length === 50) {
                // There might be more data, request next chunk
                wsSessionsOffset += 50;
                sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
            } else {
                // Done fetching all chunks
                allSessionsData = wsSessionsBuffer;
                wsSessionsBuffer = null; // free memory reference
                renderPatientPills(allSessionsData);
                updateDoctorDashboardView();
            }
        } else if (usePolling) {
            // HTTP fallback mode
            allSessionsData = chunk;
            renderPatientPills(allSessionsData);
            updateDoctorDashboardView();
        }"""
    content = content.replace(sessionslist_target, sessionslist_replace)

    with open('data/app.js', 'w', encoding='utf-8') as f:
        f.write(content)

fix()
