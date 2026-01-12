const vscode = require("vscode");
const axios = require("axios");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let goAgentProcess = null;
let AGENT_BASE = null;

function readAgentPort(extPath) {
  try {
    const p = path.join(extPath, "server", "go_agent", "agent.port");
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "8080"; // backward compatible fallback
  }
}


function activate(context) {
  /* =========================================================
     START GO AGENT AS SIDECAR (FIXED & CORRECT)
     ========================================================= */
  try {
    const agentPort = readAgentPort(context.extensionPath);
    AGENT_BASE = `http://127.0.0.1:${agentPort}`;

    const isWin = process.platform === "win32";

    const goAgentBinary = isWin ? "go-agent.exe" : "go-agent";

    const goAgentPath = path.join(
      context.extensionPath,
      "server",
      goAgentBinary
    );

    // IMPORTANT: config.yaml lives here
    const goAgentCwd = path.join(
      context.extensionPath,
      "server",
      "go_agent"
    );

    goAgentProcess = spawn(goAgentPath, [], {
      cwd: goAgentCwd,
      windowsHide: true,
      detached: false,
      stdio: "inherit"
    });

    goAgentProcess.unref();

    context.subscriptions.push({
      dispose: () => {
        if (goAgentProcess) {
          try {
            process.kill(goAgentProcess.pid);
          } catch (e) {}
          goAgentProcess = null;
        }
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage("Failed to start Go agent sidecar");
  }

  /* =========================================================
     EXISTING CODE (UNCHANGED)
     ========================================================= */
  const provider = new LogFetcherViewProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("logFetcherView", provider)
  );

  const onDidWriteTerminalData = /** @type {any} */ (vscode.window)
    .onDidWriteTerminalData;

  if (!onDidWriteTerminalData) {
    vscode.window.showErrorMessage(
      "Terminal data API not available. Run with --enable-proposed-api"
    );
    return;
  }

  let capturing = false;
  let batch = [];
  let pendingQueue = [];
  let sending = false;

  const disposable = onDidWriteTerminalData((event) => {
    if (!capturing) return;

    const raw = event.data?.trim();
    if (!raw) return;

    const log = {
      severity: detectSeverity(raw),
      timestamp: new Date().toISOString(),
      message: raw,
      raw
    };

    batch.push(log);
    provider.postCapturedLog(log);

    if (batch.length >= 50) {
      pendingQueue.push({ logs: batch });
      batch = [];
      processQueue();
    }
  });

  async function processQueue() {
    if (sending || pendingQueue.length === 0) return;
    sending = true;

    const payload = pendingQueue.shift();
    await sendBatch(payload, provider);

    sending = false;
    processQueue();
  }

  provider.onMessage = (msg) => {
    if (msg.type === "start") capturing = true;
    if (msg.type === "stop") capturing = false;
    if (msg.type === "analyze") provider.sendForAnalyze();
  };

  context.subscriptions.push(disposable);
  vscode.window.showInformationMessage("OPSCURE Activated!");
}

function deactivate() {
  if (goAgentProcess) {
    try {
      process.kill(goAgentProcess.pid);
    } catch (e) {}
    goAgentProcess = null;
  }
}

class LogFetcherViewProvider {
  constructor() {
    this.view = undefined;
    this.parsedResponses = [];
    this.rawBundles = [];
    this.bundleCounter = 1;
    this.onMessage = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage((msg) => {
      this.onMessage?.(msg);
    });
  }

  postCapturedLog(log) {
    this.view?.webview.postMessage({ type: "captured", data: log });
  }

  postParsedLog(log) {
    const parsedLog = {
      severity: log.severity || "INFO",
      message: log.message || "",
      service: log.service || "unknown",
      timestamp: log.timestamp || new Date().toISOString()
    };
    this.parsedResponses.push(parsedLog);
    this.view?.webview.postMessage({ type: "parsed", data: parsedLog });
  }

  storeBundle(bundle) {
    if (bundle) this.rawBundles.push(bundle);
  }

  async sendForAnalyze() {
    if (!this.rawBundles.length) return;

    const sequence = [];

    this.rawBundles.forEach(b => {
      const seq = b.Sequence || b.sequence;
      if (Array.isArray(seq)) {
        seq.forEach(item => {
          if (item?.Data) {
            sequence.push({ Data: item.Data });
          }
        });
      }
    });

    if (!sequence.length) return;

    const today = new Date();
    const dateStr =
      String(today.getDate()).padStart(2, "0") +
      String(today.getMonth() + 1).padStart(2, "0") +
      today.getFullYear();

    const bundleId = `bundle${dateStr}_${String(this.bundleCounter++).padStart(2, "0")}`;

    const requestBody = {
      bundle: {
        id: bundleId,
        Sequence: sequence
      }
    };

    const res = await axios.post(
      `${AGENT_BASE}/logs/preprocess`,
      requestBody,
      { headers: { "Content-Type": "application/json" } }
    );

    this.view?.webview.postMessage({
      type: "analyzeResponse",
      data: res.data
    });
  }

  getHtml() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
content="default-src 'none'; style-src 'unsafe-inline';
script-src 'unsafe-inline';">
<style>
body {
  margin:0;
  font-family: var(--vscode-font-family);
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}
.header {
  padding:10px;
  display:flex;
  gap:8px;
  border-bottom:1px solid var(--vscode-editorGroup-border);
}
button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border:none;
  padding:4px 10px;
  border-radius:4px;
}
.container { padding:10px; }
.section {
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:6px;
  margin-bottom:12px;
  height:360px;
  display:flex;
  flex-direction:column;
}
.section-header {
  padding:8px 12px;
  display:flex;
  justify-content:space-between;
  border-bottom:1px solid var(--vscode-editorGroup-border);
}
.section-content {
  flex:1;
  overflow:auto;
  padding:10px;
}
.log {
  font-size:12px;
  margin-bottom:6px;
  padding:6px 10px;
  border-left:3px solid;
  border-radius:4px;
}
.severity-ERROR { border-left-color:#f14c4c; }
.severity-WARN { border-left-color:#cca700; }
.severity-INFO { border-left-color:#4fc1ff; }
.severity-DEBUG { border-left-color:#8f8f8f; }
pre { font-size:12px; }
.counter {
  color: var(--vscode-descriptionForeground);
  font-size:11px;
}
</style>
</head>

<body>
<div class="header">
  OPSCURE
  <button onclick="start()">Start</button>
  <button onclick="stop()">Stop</button>
</div>

<div class="container">

<div class="section">
  <div class="section-header">
    Captured Logs <span class="counter" id="capCount">(0)</span>
  </div>
  <div class="section-content" id="captured"></div>
</div>

<div class="section">
  <div class="section-header">
    Parsed Response Logs <span class="counter" id="parCount">(0)</span>
    <button id="analyzeBtn" style="display:none" onclick="analyze()">Analyze</button>
  </div>
  <div class="section-content" id="parsed"></div>
</div>

<div class="section">
  <div class="section-header">Preprocess Response</div>
  <div class="section-content" id="preprocessRes"></div>
</div>

<div class="section">
  <div class="section-header">Analyze Response</div>
  <div class="section-content" id="analyzeRes"></div>
</div>

</div>

<script>
const vscode = acquireVsCodeApi();
let cap = 0, par = 0;

function start(){ vscode.postMessage({type:"start"}); }
function stop(){ vscode.postMessage({type:"stop"}); }
function analyze(){ vscode.postMessage({type:"analyze"}); }

window.addEventListener("message", e => {
  const { type, data } = e.data;

  if(type==="captured"){
    addLog("captured", data);
    document.getElementById("capCount").textContent="("+(++cap)+")";
  }

  if(type==="parsed"){
    addLog("parsed", data);
    document.getElementById("parCount").textContent="("+(++par)+")";
    document.getElementById("analyzeBtn").style.display="inline-block";
  }

  if(type==="analyzeResponse"){
    document.getElementById("preprocessRes").innerHTML="";
    document.getElementById("analyzeRes").innerHTML="";

    if(data.preprocess_response){
      showJson("preprocessRes", data.preprocess_response);
    }
    if(data.analyze_response){
      showJson("analyzeRes", data.analyze_response);
    }
  }
});

function addLog(id,d){
  const el=document.createElement("div");
  el.className="log severity-"+d.severity;
  el.textContent=\`[\${d.severity}] \${d.timestamp} \${d.service||""} \${d.message}\`;
  document.getElementById(id).prepend(el);
}

function showJson(id,data){
  const pre=document.createElement("pre");
  pre.textContent=JSON.stringify(data,null,2);
  document.getElementById(id).appendChild(pre);
}
</script>
</body>
</html>`;
  }
}

// helpers
function detectSeverity(text) {
  if (/error/i.test(text)) return "ERROR";
  if (/warn/i.test(text)) return "WARN";
  if (/debug/i.test(text)) return "DEBUG";
  return "INFO";
}

async function sendBatch(payload, provider) {
  const res = await axios.post(
    `${AGENT_BASE}/stream/ingest`,
    payload,
    { headers: { "Content-Type": "application/json" } }
  );

  if (res.data?.bundle) {
    provider.storeBundle(res.data.bundle);
  }

  const seq =
    res.data?.bundle?.Sequence ||
    res.data?.bundle?.sequence ||
    [];

  seq.forEach(item => {
    const d = item.Data || item.data;
    if (!d) return;

    provider.postParsedLog({
      severity: d.level || "INFO",
      message: d.message || "",
      service: d.service || "unknown",
      timestamp: d.timestamp || new Date().toISOString()
    });
  });
}

module.exports = { activate, deactivate };
