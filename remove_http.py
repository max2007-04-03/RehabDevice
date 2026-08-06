import re

def run():
    with open('data/app.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove usePolling and pollTimer declarations
    content = re.sub(r'let usePolling = false;\s*let pollTimer = null;\s*', '', content)

    # 2. Replace sendCommand
    send_cmd_target = r'// Send commands via WebSocket if open, otherwise fallback to HTTP API\s*function sendCommand\(cmd, params\) \{[\s\S]*?\}\s*\}'
    send_cmd_replace = '''// Send commands via WebSocket
function sendCommand(cmd, params) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    }
}'''
    content = re.sub(send_cmd_target, send_cmd_replace, content)

    # 3. Replace initConnection and startHttpPolling, pollOnce
    init_conn_target = r'// Connect via both HTTP polling \(immediate\) and WebSocket \(upgrade when ready\)\s*function initConnection\(\) \{[\s\S]*?function pollOnce\(\) \{[\s\S]*?\}\s*\}'
    init_conn_replace = '''// Connect via WebSocket
function initConnection() {
    initWebSocket();
}'''
    content = re.sub(init_conn_target, init_conn_replace, content)

    # 4. Clean ws.onopen
    onopen_target = r'ws\.onopen = \(\) => \{\s*// WebSocket connected — stop HTTP polling fallback and switch to WS\s*usePolling = false;\s*if \(pollTimer\) \{\s*clearInterval\(pollTimer\);\s*pollTimer = null;\s*\}\s*document\.getElementById\("statusDot"\)\.classList\.add\("connected"\);'
    onopen_replace = '''ws.onopen = () => {
        document.getElementById("statusDot").classList.add("connected");'''
    content = re.sub(onopen_target, onopen_replace, content)

    # 5. Clean ws.onclose
    onclose_target = r'ws\.onclose = \(\) => \{\s*ws = null;\s*// If HTTP polling is already active, just keep it going\s*if \(!pollTimer\) \{\s*usePolling = true;\s*document\.getElementById\("statusDot"\)\.classList\.remove\("connected"\);\s*document\.getElementById\("statusText"\)\.textContent = "Відключено \(перепідключення\.\.\.\)";\s*\}'
    onclose_replace = '''ws.onclose = () => {
        ws = null;
        document.getElementById("statusDot").classList.remove("connected");
        document.getElementById("statusText").textContent = "Відключено (перепідключення...)";'''
    content = re.sub(onclose_target, onclose_replace, content)

    # 6. Replace fetchAllSessionsPaginated
    fetch_sessions_target = r'async function fetchAllSessionsPaginated\(\) \{\s*if \(!usePolling && ws && ws\.readyState === WebSocket\.OPEN\) \{[\s\S]*?console\.error\("Error fetching sessions:", e\);\s*\}\s*\}'
    fetch_sessions_replace = '''function fetchAllSessionsPaginated() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Request in small chunks to prevent ESP32 RAM crash (std::bad_alloc)
        wsSessionsOffset = 0;
        wsSessionsBuffer = [];
        sendCommand("getSessions", { limit: 50, offset: wsSessionsOffset });
    }
}'''
    content = re.sub(fetch_sessions_target, fetch_sessions_replace, content)

    # 7. Clean ws.onmessage sessionsList chunk
    sessions_list_target = r'if \(!usePolling && ws && ws\.readyState === WebSocket\.OPEN && wsSessionsBuffer !== null\) \{[\s\S]*?\} else \{\s*// HTTP fallback mode\s*allSessionsData = chunk;\s*renderPatientPills\(allSessionsData\);\s*updateDoctorDashboardView\(\);\s*\}'
    sessions_list_replace = '''if (ws && ws.readyState === WebSocket.OPEN && wsSessionsBuffer !== null) {
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
        }'''
    content = re.sub(sessions_list_target, sessions_list_replace, content)

    with open('data/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
        
    print("Done")

if __name__ == "__main__":
    run()
