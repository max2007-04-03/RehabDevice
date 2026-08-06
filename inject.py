import sys

def inject_debug():
    with open('data/index.html', 'r', encoding='utf-8') as f:
        html = f.read()

    # Ensure we don't inject multiple times
    if "debugConsole" in html:
        return

    debug_script = """
    <script>
        (function() {
            var debugConsole = null;
            
            function ensureConsole() {
                if (debugConsole) return debugConsole;
                if (!document.body) return null;
                
                debugConsole = document.createElement("div");
                debugConsole.id = "debugConsole";
                debugConsole.style.position = "fixed";
                debugConsole.style.top = "0";
                debugConsole.style.left = "0";
                debugConsole.style.width = "100%";
                debugConsole.style.height = "40%";
                debugConsole.style.background = "rgba(0,0,0,0.95)";
                debugConsole.style.color = "#00ff00";
                debugConsole.style.fontFamily = "monospace";
                debugConsole.style.fontSize = "12px";
                debugConsole.style.overflowY = "scroll";
                debugConsole.style.zIndex = "999999";
                debugConsole.style.padding = "10px";
                debugConsole.style.pointerEvents = "none";
                document.body.appendChild(debugConsole);
                return debugConsole;
            }

            var logs = [];
            function logToScreen(msg, color) {
                logs.push({msg: msg, color: color});
                var cons = ensureConsole();
                if (cons) {
                    while (logs.length > 0) {
                        var log = logs.shift();
                        var p = document.createElement("div");
                        p.style.color = log.color;
                        p.style.borderBottom = "1px solid #333";
                        p.style.padding = "4px 0";
                        p.style.wordWrap = "break-word";
                        p.textContent = log.msg;
                        cons.appendChild(p);
                    }
                    cons.scrollTop = cons.scrollHeight;
                }
            }

            document.addEventListener('DOMContentLoaded', function() {
                ensureConsole();
                logToScreen('[SYS] DOMContentLoaded. Debug console ready.', '#00ffff');
            });

            var origLog = console.log;
            console.log = function() {
                origLog.apply(console, arguments);
                var msg = Array.prototype.slice.call(arguments).join(" ");
                logToScreen("[LOG] " + msg, "#00ff00");
            };

            var origErr = console.error;
            console.error = function() {
                origErr.apply(console, arguments);
                var msg = Array.prototype.slice.call(arguments).join(" ");
                logToScreen("[ERR] " + msg, "#ff4444");
            };

            window.onerror = function(message, source, lineno, colno, error) {
                logToScreen("[EXCEPTION] " + message + " at " + (source||'').split('/').pop() + ":" + lineno + ":" + colno, "#ff0000");
                return false;
            };
            
            logToScreen("[SYS] Logger initialized before scripts.", "#00ffff");
        })();
    </script>
"""
    
    # insert right after <head>
    html = html.replace('<head>', '<head>\n' + debug_script)
    
    with open('data/index.html', 'w', encoding='utf-8') as f:
        f.write(html)

inject_debug()
