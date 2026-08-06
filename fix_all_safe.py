import sys

def run():
    with open('data/app.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove usePolling and pollTimer declarations
    content = content.replace('let usePolling = false;\nlet pollTimer = null;\n', '')
    
    # 2. Replace sendCommand
    send_cmd_target = """// Send commands via WebSocket if open, otherwise fallback to HTTP API
function sendCommand(cmd, params) {
    if (!usePolling && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    } else {
        let url = `${DEVICE_HOST}/api/cmd?action=${encodeURIComponent(cmd)}`;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
            }
        }
        fetch(url).then(() => {
            // Poll immediately after executing command
            setTimeout(pollOnce, 400);
        }).catch(() => {});
    }
}"""
    send_cmd_replace = """// Send commands via WebSocket
function sendCommand(cmd, params) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    }
}"""
    content = content.replace(send_cmd_target, send_cmd_replace)
    
    # 3. Replace initConnection
    init_conn_target = """// Connect via both HTTP polling (immediate) and WebSocket (upgrade when ready)
function initConnection() {
    // Start HTTP polling immediately so the UI updates right away
    // (works even in captive portal WebView where WebSocket is blocked)
    usePolling = true;
    startHttpPolling();

    // Attempt WebSocket upgrade in parallel — if it connects, polling will be stopped
    try {
        initWebSocket();
    } catch (e) {}
}

// HTTP polling fallback for Captive Portal environments and restricted browsers
function startHttpPolling() {
    // Don't set "connected" here — let the first successful pollOnce response update the status

    // Synchronize client timestamp with ESP32 (applying local timezone offset)
    const localUnix = Math.floor(Date.now() / 1000) - (new Date().getTimezoneOffset() * 60);
    fetch(`${DEVICE_HOST}/api/cmd?action=syncTime&timestamp=${localUnix}`).catch(() => {});

    // Load all sessions via pagination
    fetchAllSessionsPaginated();

    // Poll once immediately, then start periodic polling (every 2 seconds)
    pollOnce();
    pollTimer = setInterval(pollOnce, 2000);
}

function pollOnce() {
    fetch(`${DEVICE_HOST}/api/status`)
        .then(r => r.json())
        .then(data => {
            document.getElementById("statusDot").classList.add("connected");
            document.getElementById("statusText").textContent = "Пристрій підключено (HTTP)";
            handleServerMessage(data);
            if (data.angle !== undefined) {
                handleServerMessage({ type: "angle", angle: data.angle });
            }
        }).catch(() => {
            document.getElementById("statusDot").classList.remove("connected");
            document.getElementById("statusText").textContent = "Відключено (очікування HTTP...)";
        });
}"""
    init_conn_replace = """// Connect via WebSocket
function initConnection() {
    try {
        initWebSocket();
    } catch (e) {}
}"""
    content = content.replace(init_conn_target, init_conn_replace)

    # 4. Clean ws.onopen
    onopen_target = """    ws.onopen = () => {
        // WebSocket connected — stop HTTP polling fallback and switch to WS
        usePolling = false;
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        document.getElementById("statusDot").classList.add("connected");"""
    onopen_replace = """    ws.onopen = () => {
        document.getElementById("statusDot").classList.add("connected");"""
    content = content.replace(onopen_target, onopen_replace)
    
    # 5. Clean ws.onclose
    onclose_target = """    ws.onclose = () => {
        ws = null;
        // If HTTP polling is already active, just keep it going
        if (!pollTimer) {
            usePolling = true;
            document.getElementById("statusDot").classList.remove("connected");
            document.getElementById("statusText").textContent = "Відключено (перепідключення...)";
        }
        // Retry WebSocket connection every 5 seconds"""
    onclose_replace = """    ws.onclose = () => {
        ws = null;
        document.getElementById("statusDot").classList.remove("connected");
        document.getElementById("statusText").textContent = "Відключено (перепідключення...)";
        
        // Retry WebSocket connection every 5 seconds"""
    content = content.replace(onclose_target, onclose_replace)
    
    # 6. Replace fetchAllSessionsPaginated
    fetch_sessions_target = """async function fetchAllSessionsPaginated() {
    if (!usePolling && ws && ws.readyState === WebSocket.OPEN) {
        // Use WebSocket to avoid creating new TCP connections (PCB exhaustion)
        // Request in small chunks to prevent ESP32 RAM crash (std::bad_alloc)
        wsSessionsOffset = 0;
        wsSessionsBuffer = [];
        sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
        return;
    }

    // Fallback for HTTP mode
    let all = [];
    let offset = 0;
    const limit = 50;
    try {
        while (true) {
            let res = await fetch(`${DEVICE_HOST}/api/sessions?offset=${offset}&limit=${limit}`, {
                headers: { 'Connection': 'keep-alive' }
            });
            if (!res.ok) break;
            let data = await res.json();
            if (!Array.isArray(data)) break;
            all = all.concat(data);
            if (data.length < limit) break;
            offset += limit;
        }
        handleServerMessage({ type: "sessionsList", sessions: all });
    } catch (e) {
        console.error("Error fetching sessions:", e);
    }
}"""
    fetch_sessions_replace = """function fetchAllSessionsPaginated() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Request in small chunks to prevent ESP32 RAM crash (std::bad_alloc)
        wsSessionsOffset = 0;
        wsSessionsBuffer = [];
        sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
    }
}"""
    content = content.replace(fetch_sessions_target, fetch_sessions_replace)
    
    # 7. Clean sessionsList
    sessionsList_target = """        if (!usePolling && ws && ws.readyState === WebSocket.OPEN && wsSessionsBuffer !== null) {
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
        } else {
            // HTTP fallback mode
            allSessionsData = chunk;
            renderPatientPills(allSessionsData);
            updateDoctorDashboardView();
        }"""
    sessionsList_replace = """        if (ws && ws.readyState === WebSocket.OPEN && wsSessionsBuffer !== null) {
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
    content = content.replace(sessionsList_target, sessionsList_replace)

    # Now, fix ?.
    content = content.replace(
        'document.getElementById("btnDownloadCSV")?.addEventListener',
        'if (document.getElementById("btnDownloadCSV")) document.getElementById("btnDownloadCSV").addEventListener'
    )
    content = content.replace(
        'document.getElementById("btnDownloadClientCSV")?.addEventListener',
        'if (document.getElementById("btnDownloadClientCSV")) document.getElementById("btnDownloadClientCSV").addEventListener'
    )
    content = content.replace(
        'document.getElementById("btnDeletePatient")?.addEventListener',
        'if (document.getElementById("btnDeletePatient")) document.getElementById("btnDeletePatient").addEventListener'
    )
    content = content.replace(
        'document.getElementById("targetNormInput")?.addEventListener',
        'if (document.getElementById("targetNormInput")) document.getElementById("targetNormInput").addEventListener'
    )

    content = content.replace(
        'if (document.getElementById("tabDoctor")?.classList.contains("active")) {',
        'if (document.getElementById("tabDoctor") && document.getElementById("tabDoctor").classList.contains("active")) {'
    )

    # option selection
    content = content.replace(
        'document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex]?.text',
        '(document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex] ? document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex].text : "Пацієнт")'
    )

    # .toFixed
    content = content.replace('rec.minAngle?.toFixed', '(rec.minAngle||0).toFixed')
    content = content.replace('rec.maxAngle?.toFixed', '(rec.maxAngle||0).toFixed')
    content = content.replace('rec.amplitude?.toFixed', '(rec.amplitude||0).toFixed')
    content = content.replace('rec.avgSpeed?.toFixed', '(rec.avgSpeed||0).toFixed')
    content = content.replace('rec.smoothness?.toFixed', '(rec.smoothness||0).toFixed')

    content = content.replace('wrapper?.clientWidth', '(wrapper ? wrapper.clientWidth : 0)')
    content = content.replace('wrapper?.clientHeight', '(wrapper ? wrapper.clientHeight : 0)')

    with open('data/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
        
    print("Done")

if __name__ == "__main__":
    run()
