import re
with open('data/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove the console.logs I added
content = content.replace('console.log("app.js has started executing!");\n', '')
content = content.replace('    console.log("initApp() called!");\n', '')
content = content.replace('    console.log("initConnection() called");\n', '')
content = content.replace('    console.log("initWebSocket() called, URL:", wsUrl);\n', '')
content = content.replace('        console.log("WebSocket onopen fired!");\n', '')
content = content.replace('        console.log("WebSocket onclose fired!");\n', '')

with open('data/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
