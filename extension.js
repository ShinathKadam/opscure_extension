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
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const { EventSource } = require("eventsource");


let goAgentProcess = null;
let AGENT_BASE = null;
let fixEventSource = null;

/* ================= APP PROCESS CONTROL ================= */

let appProcess = null;
let opscureTerminal = null;
let writeEmitter = null;

/* ================= HARD PROCESS KILL ================= */

function killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

function killByPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`).toString();
      out.split("\n").forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          execSync(`taskkill /PID ${pid} /T /F`);
        }
      });
    } else {
      execSync(`lsof -ti tcp:${port} | xargs kill -9`);
    }
  } catch {}
}

function extractPort(cmd) {
  const m = cmd.match(/:(\d{2,5})/);
  return m ? m[1] : null;
}

function killRunningApp() {
  if (appProcess?.pid) {
    killProcessTree(appProcess.pid);
  }
  appProcess = null;
}

/* ================= AGENT PORT ================= */

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

/* ================= ACTIVATE ================= */

function activate(context) {

  /* ================= START GO AGENT ================= */

  try {
    const isWin = process.platform === "win32";
    const goAgentBinary = isWin ? "go-agent.exe" : "go-agent";

    const goAgentPath = path.join(context.extensionPath, "server", goAgentBinary);
    const goAgentCwd = path.join(context.extensionPath, "server", "go_agent");

    goAgentProcess = spawn(goAgentPath, [], {
      cwd: goAgentCwd,
      windowsHide: true,
      stdio: "inherit"
    });

    waitForAgentPort(context.extensionPath)
      .then(port => {
        AGENT_BASE = `http://127.0.0.1:${port}`;
        vscode.window.showInformationMessage("OPSCURE agent connected on port " + port);
      })
      .catch(() => vscode.window.showErrorMessage("Go agent port not detected"));

    context.subscriptions.push({
      dispose: () => {
        if (goAgentProcess?.pid) killProcessTree(goAgentProcess.pid);
      }
    });

  } catch {
    vscode.window.showErrorMessage("Failed to start Go agent sidecar");
  }

  /* ================= EXISTING UI + PIPELINE ================= */

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

  /* ================= TERMINAL ATTACH MODE ================= */

  function ensureTerminal() {
    if (opscureTerminal) return;

    writeEmitter = new vscode.EventEmitter();

    const pty = {
      onDidWrite: writeEmitter.event,
      open: () => {},
      close: () => {
        killRunningApp();
      }
    };

    opscureTerminal = vscode.window.createTerminal({ name: "OPSCURE", pty });
    opscureTerminal.show();
  }

  function runCommand(cmd) {
    ensureTerminal();
    killRunningApp();

    // 🔥 free busy port first
    const port = extractPort(cmd);
    if (port) killByPort(port);

    appProcess = spawn(cmd, {
      cwd: vscode.workspace.rootPath,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    appProcess.stdout.on("data", d => {
      const text = d.toString();
      writeEmitter.fire(text);
      if (capturing) pushLog(text.trim());
    });

    appProcess.stderr.on("data", d => {
      const text = d.toString();
      writeEmitter.fire(text);
      if (capturing) pushLog(text.trim());
    });

    appProcess.on("close", code => {
      writeEmitter.fire(`\r\n[OPSCURE] process exited with code ${code}\r\n`);
      appProcess = null;
    });
  }

  /* ================= UI EVENTS ================= */

  provider.onMessage = async (msg) => {
    if (msg.type === "start") {
      capturing = true;
      if (msg.command) runCommand(msg.command);
    }

    if (msg.type === "stop") {
      capturing = false;
      killRunningApp();
    }

    if (msg.type === "analyze") provider.sendForAnalyze();

    if (msg.type === "acceptFix") {
      await applyFixFromAI(provider);
    }

    if (msg.type === "ignoreFix") {
      vscode.window.showInformationMessage("Fix ignored by user.");
    }
  };

  context.subscriptions.push({
    dispose: () => {
      killRunningApp();
      if (fixEventSource) fixEventSource.close();
    }
  });

  vscode.window.showInformationMessage("OPSCURE Activated!");
}

function deactivate() {
  if (goAgentProcess?.pid) killProcessTree(goAgentProcess.pid);
  killRunningApp();
  if (fixEventSource) fixEventSource.close();
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

  postFixStatus(msg) {
    this.view?.webview.postMessage({ type: "fixStatus", data: msg });
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

    const res = await axios.post(
      `${AGENT_BASE}/logs/preprocess`,
      requestBody,
      { headers: { "Content-Type": "application/json" } }
    );

    // STORE AI RESPONSE
    this.lastAnalyzeResponse = res.data;

    this.view?.webview.postMessage({
      type: "analyzeResponse",
      data: res.data
    });
  }

/* ------------- Only Analyze UI section is enhanced ---------------------- */

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
  padding:6px 12px;
  border-radius:6px;
  cursor:pointer;
}
button.secondary {
  background:#3a3d41;
}
button.accept {
  background:#238636;
}
button.ignore {
  background:#a1260d;
}
input {
  flex:1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border);
  border-radius:4px;
  padding:4px 8px;
}
.container { padding:10px; }
.section {
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:10px;
  margin-bottom:12px;
  height:360px;
  display:flex;
  flex-direction:column;
  overflow:hidden;
}
.section-header {
  padding:10px 14px;
  display:flex;
  justify-content:space-between;
  border-bottom:1px solid var(--vscode-editorGroup-border);
  font-weight:600;
}
.section-content {
  flex:1;
  overflow:auto;
  padding:12px;
}
.log {
  font-size:12px;
  margin-bottom:6px;
  padding:6px 10px;
  border-left:3px solid;
  border-radius:6px;
}
.severity-ERROR { border-left-color:#f14c4c; }
.severity-WARN { border-left-color:#cca700; }
.severity-INFO { border-left-color:#4fc1ff; }
.severity-DEBUG { border-left-color:#8f8f8f; }

.card {
  background:#161b22;
  border:1px solid #30363d;
  border-radius:10px;
  padding:12px;
  margin-bottom:10px;
}
.card h3 {
  margin:0 0 6px;
  font-size:14px;
}
.kv {
  font-size:12px;
  margin:2px 0;
  color:#c9d1d9;
}
.timeline {
  font-size:12px;
  padding-left:14px;
}
.timeline li {
  margin-bottom:4px;
}
.badge {
  display:inline-block;
  padding:2px 8px;
  border-radius:20px;
  font-size:11px;
  background:#30363d;
  margin-right:6px;
}
.actions {
  display:flex;
  gap:10px;
  margin-top:12px;
}
.counter {
  color: var(--vscode-descriptionForeground);
  font-size:11px;
}
</style>
</head>

<body>
<div class="header">
  <input id="cmd" placeholder="Enter command (example: npm start)" oninput="validate()" />
  <button id="startBtn" onclick="start()" disabled>Start</button>
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

<div class="section">
  <div class="section-header">🛠 Fix Progress</div>
  <div class="section-content" id="fixBox"></div>
</div>

</div>

<script>
const vscode = acquireVsCodeApi();
let cap = 0, par = 0;

function validate(){
  document.getElementById("startBtn").disabled =
    !document.getElementById("cmd").value.trim();
}

function start(){
  vscode.postMessage({type:"start", command: document.getElementById("cmd").value});
}

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
      renderAnalyze(data.analyze_response, data.preprocess_response);
    }
  }

  if(type==="fixStatus"){
    const box = document.getElementById("fixBox");
    const div = document.createElement("div");
    div.className="log";
    div.textContent = data;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
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

/* ================= ANALYZE UI ================= */

function renderAnalyze(res, preprocess){
  const root = res.recommendation;
  if(!root) return;

  const rca = root.root_cause_analysis || {};
  const metrics = preprocess?.bundle?.metrics || {};
  const ev = rca.evidence || {};

  const errorRate = metrics.errorRateZ ?? (ev.metric === "errorRateZ" ? ev.value : "-");
  const cpu = metrics.cpuZ ?? (ev.metric === "cpuZ" ? ev.value : "-");
  const latency = metrics.latencyZ ?? (ev.metric === "latencyZ" ? ev.value : "-");

  const rec = (root.recommendations||[])[0];
  const conf = root.confidence_assessment || {};

  const box = document.getElementById("analyzeRes");

  box.innerHTML = \`
    <div class="card">
      <h3>🔍 Incident Summary</h3>
      <div class="kv"><b>Summary:</b> \${rca.summary||"-"}</div>
      <div class="kv"><b>Primary Cause:</b> \${rca.primary_cause||"-"}</div>
      <div class="kv"><b>Impact:</b> \${rca.impact||"-"}</div>
    </div>

    <div class="card">
      <h3>📊 Key Signals</h3>
      <span class="badge">Error Rate: \${errorRate}</span>
      <span class="badge">CPU: \${cpu}</span>
      <span class="badge">Latency: \${latency}</span>
    </div>


    <div class="card">
      <h3>🧩 Timeline</h3>
      <ul class="timeline">
        \${(rca.timeline||[]).map(t=>\`<li>\${t}</li>\`).join("")}
      </ul>
    </div>

    \${rec ? \`
    <div class="card">
      <h3>🛠 Recommended Fix</h3>
      <div class="kv"><b>\${rec.title}</b></div>
      <div class="kv">\${rec.description}</div>
      <div class="kv">Type: \${rec.fix_type} | Risk: \${rec.risk_level}</div>
      <div class="kv">Effort: \${rec.estimated_effort} | Time: \${rec.estimated_time_minutes} mins</div>
      <div class="kv">AI Confidence: \${rec.ai_confidence}</div>
    </div>\` : ""}

    <div class="card">
      <h3>🧠 Confidence</h3>
      <div class="kv">Final Confidence: \${conf.final_confidence}</div>
      <div class="kv">Auto Heal: \${root.auto_heal_candidate}</div>
      <div class="kv">Human Review: \${root.requires_human_review}</div>
    </div>

    <div class="actions">
      <button class="accept" onclick="acceptFix()">Accept</button>
      <button class="ignore" onclick="ignoreFix()">Ignore</button>
    </div>
  \`;
}

function acceptFix(){
  vscode.postMessage({type:"acceptFix"});
}

function ignoreFix(){
  vscode.postMessage({type:"ignoreFix"});
}
</script>
</body>
</html>`;
  }
}



/* ================= HELPERS (UNCHANGED) ================= */

function detectSeverity(text) {
  if (/error/i.test(text)) return "ERROR";
  if (/warn/i.test(text)) return "WARN";
  if (/debug/i.test(text)) return "DEBUG";
  return "INFO";
}

async function sendBatch(payload, provider) {
  if (!AGENT_BASE) return;

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

function startFixStream(provider){
  if (fixEventSource) {
    fixEventSource.close();
    fixEventSource = null;
  }

  fixEventSource = new EventSource(`${AGENT_BASE}/fix/stream`);

  fixEventSource.onmessage = (e) => {
    const msg = e.data;

    if(msg === "__CLOSE__"){
      provider.postFixStatus("✅ Fix workflow finished.");
      fixEventSource.close();
      fixEventSource = null;
      return;
    }

    provider.postFixStatus(msg);
  };

  fixEventSource.onerror = () => {
    provider.postFixStatus("❌ Fix stream disconnected.");
    fixEventSource?.close();
    fixEventSource = null;
  };
}


async function applyFixFromAI(provider) {
  if (!AGENT_BASE) {
    vscode.window.showErrorMessage("Go agent not connected yet.");
    return;
  }

  if (!provider.lastAnalyzeResponse) {
    vscode.window.showWarningMessage("No AI response available.");
    return;
  }

  const workspace = vscode.workspace.rootPath;
  if (!workspace) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  try {
    await axios.post(`${AGENT_BASE}/fix/apply`, {
      ai_response: provider.lastAnalyzeResponse,
      workspace: workspace
    }, {
      headers: { "Content-Type": "application/json" }
    });

    vscode.window.showInformationMessage("OPSCURE: Fix execution started.");
    startFixStream(provider);
  } catch (err) {
    vscode.window.showErrorMessage(
      "Failed to apply fix: " + (err.response?.data || err.message)
    );
  }
}

module.exports = { activate, deactivate };
