/*
 * Copyright (c) 2026 OPSCURE.
 * All rights reserved.
 *
 * This software is the confidential and proprietary information of OPSCURE.
 * Unauthorized copying, modification, distribution, or use of this software,
 * via any medium, is strictly prohibited without prior written permission.
 *
 * Licensed under the OPSCURE Software License Agreement.
 */

const vscode = require("vscode");
const axios = require("axios");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

let goAgentProcess = null;
let AGENT_BASE = null;

function readAgentPort(extPath) {
  try {
    const p = path.join(extPath, "server", "agent.port");
    const port = fs.readFileSync(p, "utf8").trim();
    return port;
  } catch {
    return null;
  }
}

// ✅ WAIT until Go agent writes fresh port
function waitForAgentPort(extPath, timeoutMs = 10000, intervalMs = 200) {
  const portFile = path.join(extPath, "server", "agent.port");
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (fs.existsSync(portFile)) {
          const port = fs.readFileSync(portFile, "utf8").trim();
          if (/^\d+$/.test(port)) {
            clearInterval(timer);
            return resolve(port);
          }
        }
      } catch {}

      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for agent.port"));
      }
    }, intervalMs);
  });
}

function activate(context) {
  /* =========================================================
     START GO AGENT AS SIDECAR (UNCHANGED)
     ========================================================= */
  try {
    const isWin = process.platform === "win32";
    const goAgentBinary = isWin ? "go-agent.exe" : "go-agent";

    const goAgentPath = path.join(context.extensionPath, "server", goAgentBinary);
    const goAgentCwd = path.join(context.extensionPath, "server", "go_agent");

    goAgentProcess = spawn(goAgentPath, [], {
      cwd: goAgentCwd,
      windowsHide: true,
      detached: false,
      stdio: "inherit"
    });

    goAgentProcess.unref();

    waitForAgentPort(context.extensionPath)
      .then(port => {
        AGENT_BASE = `http://127.0.0.1:${port}`;
        vscode.window.showInformationMessage("OPSCURE agent connected on port " + port);
      })
      .catch(() => {
        vscode.window.showErrorMessage("Go agent port not detected");
      });

    context.subscriptions.push({
      dispose: () => {
        if (goAgentProcess) {
          try { process.kill(goAgentProcess.pid); } catch {}
          goAgentProcess = null;
        }
      }
    });
  } catch {
    vscode.window.showErrorMessage("Failed to start Go agent sidecar");
  }

  /* =========================================================
     EXISTING UI + PIPELINE (UNCHANGED)
     ========================================================= */
  const provider = new LogFetcherViewProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("logFetcherView", provider)
  );

  let capturing = false;
  let batch = [];
  let pendingQueue = [];
  let sending = false;

  function pushLog(raw) {
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
  }

  async function processQueue() {
    if (sending || pendingQueue.length === 0) return;
    sending = true;

    const payload = pendingQueue.shift();
    await sendBatch(payload, provider);

    sending = false;
    processQueue();
  }

  // ================= PTY TERMINAL (ONLY CAPTURE SOURCE) =================

  async function startOpscureTerminal() {
    const cmd = await vscode.window.showInputBox({
      prompt: "Enter command to run with OPSCURE (example: npm start)"
    });
    if (!cmd) return;

    const [command, ...args] = cmd.split(" ");
    let writeEmitter = new vscode.EventEmitter();

    const pty = {
      onDidWrite: writeEmitter.event,
      open: () => {
        const proc = spawn(command, args, {
          cwd: vscode.workspace.rootPath,
          shell: true
        });

        proc.stdout.on("data", d => {
          const text = d.toString();
          writeEmitter.fire(text);
          pushLog(text.trim());
        });

        proc.stderr.on("data", d => {
          const text = d.toString();
          writeEmitter.fire(text);
          pushLog(text.trim());
        });

        proc.on("close", code => {
          writeEmitter.fire(`\r\n[OPSCURE] process exited with code ${code}\r\n`);
        });
      },
      close: () => {}
    };

    const terminal = vscode.window.createTerminal({ name: "OPSCURE", pty });
    terminal.show();
  }

  provider.onMessage = async (msg) => {
    if (msg.type === "start") {
      capturing = true;
      await startOpscureTerminal();   // ✅ auto start terminal
    }
    if (msg.type === "stop") capturing = false;
    if (msg.type === "analyze") provider.sendForAnalyze();
  };

  vscode.window.showInformationMessage("OPSCURE Activated!");
}

function deactivate() {
  if (goAgentProcess) {
    try { process.kill(goAgentProcess.pid); } catch {}
    goAgentProcess = null;
  }
}

/* ===================== YOUR ORIGINAL CLASSES & UI ===================== */

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
    if (!AGENT_BASE) {
      vscode.window.showWarningMessage("Agent not ready yet.");
      return;
    }

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

    console.log("[OPSCURE] Invoking API: POST", `${AGENT_BASE}/logs/preprocess`);

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
  if (!AGENT_BASE) {
    console.log("[OPSCURE] Agent not ready yet, skipping /stream/ingest");
    return;
  }

  console.log("[OPSCURE] Invoking API: POST", `${AGENT_BASE}/stream/ingest`);

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