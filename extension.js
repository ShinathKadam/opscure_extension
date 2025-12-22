// opscure-log-fetcher.js
// VS Code extension (plain JavaScript).
// Implements stream ingest flow:
//  - Removed Fetch Log and all previous /logs calls
//  - "Stream logs" starts a 4s interval calling /stream/ingest?app_name=&log_type=
//  - Renders only level, timestamp, message if response.bundle is present
//  - Does not clear previous logs when bundle is null
//  - Start/Stop buttons renamed and wired: Stream logs / Stop stream
//  - Analyze / Apply / Diff features retained
//  - Secure API key storage via VS Code secrets

const vscode = require('vscode');
const crypto = require('crypto');
const axios = require('axios');

let providerRef;

function activate(context) {
  providerRef = new OpscureSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logFetcherView', providerRef)
  );
  console.log('OPSCURE Log Fetcher activated');
}

function deactivate() {
  if (providerRef) providerRef.dispose();
}

class OpscureSidebarProvider {
  constructor(context) {
    this.context = context;
    this.webviewView = null;

    this._userId = null;
    this._apiKey = null;

    this._lastFetchedLogs = []; // normalized entries array
    this._streamInterval = null;
    this._streaming = false;

    this._initSecretsPromise = this._initSecrets();
  }

  async _initSecrets() {
    try {
      const secrets = this.context.secrets;
      let userId = await secrets.get('opscure.userId');
      if (!userId) {
        userId = this._generateId();
        await secrets.store('opscure.userId', userId);
      }
      this._userId = userId;

      const apiKey = await secrets.get('opscure.apiKey');
      this._apiKey = apiKey || null;
    } catch (e) {
      console.error('Failed to initialize secrets:', e);
    }
  }

  _generateId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  }

  async saveApiKey(key) {
    try {
      await this.context.secrets.store('opscure.apiKey', key);
      this._apiKey = key;
    } catch (e) {
      console.error('Failed to save API key:', e);
      throw e;
    }
  }

  async deleteApiKey() {
    try {
      await this.context.secrets.delete('opscure.apiKey');
      this._apiKey = null;
    } catch (e) {
      console.error('Failed to delete API key:', e);
      throw e;
    }
  }

  _escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Normalize stream bundle item: Sequence[i].Data
  // -> { raw, severity, timestamp }
  _normalizeStreamItem(dataObj) {
    if (!dataObj || typeof dataObj !== 'object') return null;
    const level = (dataObj.level || 'INFO').toUpperCase();
    const timestamp = dataObj.timestamp || '';
    const message = dataObj.message || '';
    return {
      raw: message,
      severity: level,
      timestamp: timestamp,
      service: '',    // intentionally omitted from rendering
      type: 'stream'
    };
  }

  // Start extension-side streaming (calls /stream/ingest every 4s)
  _startStreaming(appName, logType) {
    if (this._streaming) return;
    this._streaming = true;

    const out = vscode.window.createOutputChannel('OPSCURE:stream');
    out.show(true);
    out.appendLine(`Starting stream ingest: app_name=${appName} log_type=${logType}`);

    this._streamInterval = setInterval(async () => {
      try {
        const base = 'http://localhost:8080/stream/ingest';
        const url = new URL(base);
        url.searchParams.set('app_name', '' + appName);
        url.searchParams.set('log_type', '' + logType);

        const finalUrl = url.toString();
        const resp = await axios.get(finalUrl, {
          timeout: 15000,
          responseType: 'json',
          validateStatus: null
        });

        const status = resp.status || 0;
        if (status < 200 || status >= 300) {
          const text = resp && resp.data ? (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)) : 'no response';
          out.appendLine(`[stream error ${status}] ${text}`);
          if (this.webviewView) {
            this.webviewView.webview.postMessage({ type: 'logsAppend', chunk: `[stream error ${status}] ${text}` });
          }
          return;
        }

        const body = resp.data;
        // Expected body examples:
        // With bundle:
        // { "accepted": 50, "bundle": { "Sequence": [ { "Data": {...}}, ... ], "Metadata": {...} }, "flushed": true }
        // Without bundle:
        // { "accepted": 50, "bundle": null, "flushed": false }

        const bundle = body && body.bundle;
        if (bundle && Array.isArray(bundle.Sequence)) {
          const normalized = bundle.Sequence
            .map(item => item && item.Data ? this._normalizeStreamItem(item.Data) : null)
            .filter(Boolean);

          if (normalized.length > 0) {
            // Append new entries; do NOT clear previous logs
            this._lastFetchedLogs = (this._lastFetchedLogs || []).concat(normalized);
            if (this.webviewView) {
              this.webviewView.webview.postMessage({ type: 'logsObjectsAppend', entries: normalized });
            }
          }
        } else {
          // bundle is null => do nothing, do not clear logs
          out.appendLine('No bundle in stream response; keeping previous logs.');
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        out.appendLine('[stream exception] ' + msg);
        if (this.webviewView) {
          this.webviewView.webview.postMessage({ type: 'logsAppend', chunk: '[stream exception] ' + msg });
        }
      }
    }, 4000);
  }

  // Stop extension-side streaming
  _stopStreaming() {
    if (!this._streaming) return;
    if (this._streamInterval) {
      clearInterval(this._streamInterval);
      this._streamInterval = null;
    }
    this._streaming = false;
    const out = vscode.window.createOutputChannel('OPSCURE:stream');
    out.show(true);
    out.appendLine('Stopped stream ingest');
  }

  // Analyze using stored logs (unchanged, uses whatever is in _lastFetchedLogs)
  async _sendAnalyzeRequestUsingStoredLogs() {
    const out = vscode.window.createOutputChannel('OPSCURE:analyze');
    out.show(true);

    try {
      if (!this._apiKey) {
        throw new Error('OpenAI API key not set. Save it in the API Key field first.');
      }

      if (!Array.isArray(this._lastFetchedLogs) || this._lastFetchedLogs.length === 0) {
        throw new Error('No logs available to analyze. Stream logs first.');
      }

      const url = 'http://127.0.0.1:8080/logs/analyze';
      const payload = {
        openai_api_key: this._apiKey,
        logs: this._lastFetchedLogs
      };

      out.appendLine('=== Analyze Request ===');
      out.appendLine(url);
      out.appendLine('payload preview: ' + JSON.stringify({ logsPreview: this._lastFetchedLogs.slice(0, 5) }));
      out.appendLine('=======================');

      const resp = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: null
      });

      const status = resp.status || 0;
      const body = resp.data;
      out.appendLine('Response ' + status + ': ' + (typeof body === 'string' ? body : JSON.stringify(body)));

      if (status >= 200 && status < 300) {
        return { statusCode: status, body: body };
      } else {
        throw new Error('Server responded ' + status + ': ' + (typeof body === 'string' ? body : JSON.stringify(body)));
      }
    } catch (err) {
      out.appendLine('Analyze error: ' + String(err));
      throw err;
    }
  }

  // Apply recommendation (unchanged)
  async _applyRecommendation(recommendation) {
    const out = vscode.window.createOutputChannel('OPSCURE:apply');
    out.show(true);

    try {
      const url = 'http://127.0.0.1:8080/logs/apply-patch';
      out.appendLine('=== Apply Recommendation Request ===');
      out.appendLine(url);
      out.appendLine('payload: ' + JSON.stringify(recommendation));
      out.appendLine('====================================');

      const resp = await axios.post(url, recommendation, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000,
        validateStatus: null
      });

      const status = resp.status || 0;
      const body = resp.data;
      out.appendLine('Response ' + status + ': ' + (typeof body === 'string' ? body : JSON.stringify(body)));

      if (status >= 200 && status < 300) {
        return { statusCode: status, body: body };
      } else {
        throw new Error('Server responded ' + status + ': ' + (typeof body === 'string' ? body : JSON.stringify(body)));
      }
    } catch (err) {
      out.appendLine('Apply error: ' + String(err));
      throw err;
    }
  }

  async getHtml() {
    await this._initSecretsPromise;
    const style = this._getStyle();
    const userId = this._userId || '(generating...)';
    const apiKeySaved = !!this._apiKey;

    const windowsCmd = 'your_command_here | Tee-Object -FilePath file_name.log';
    const unixCmd = 'your_command_here 2>&1 | tee -a file_name.log';

    const instructionText = 'If your app is running locally and you are not storing live logs in a log file, first stop/kill the currently running server. Then run one of the commands below to capture live terminal output to a file in your project root. When you restart the server, run the same command again to resume capturing.';

    const escapedInstruction = this._escapeHtml(instructionText);
    const escapedWindows = this._escapeHtml(windowsCmd);
    const escapedUnix = this._escapeHtml(unixCmd);

    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8" />',
      style,
      '</head>',
      '<body>',
      '<h2>OPSCURE Log Fetcher</h2>',

      // Instruction banner
      '<div class="instruction-banner" role="region" aria-label="Log capture instructions">',
        '<div class="instruction-head">',
          '<div style="flex:1; min-width:0;">',
            '<strong>Capture live logs to a file</strong>',
            `<div class="instruction-body">${escapedInstruction}</div>`,
          '</div>',
          '<div style="min-width:140px; text-align:right;"><div class="small-muted">Quick copy</div></div>',
        '</div>',

        '<div class="instruction-commands" role="list">',

          '<div class="cmd-card" title="Windows PowerShell / CMD" role="listitem">',
            '<div class="cmd-meta">',
              '<div class="cmd-title">Windows (PowerShell / CMD)</div>',
              '<div class="cmd-line">',
                `<div id="cmdWin" class="cmd-block" aria-label="Windows command">${escapedWindows}</div>`,
                '<button class="copy-small" onclick="copyCommand(\'cmdWin\', this)" aria-label="Copy Windows command">Copy</button>',
              '</div>',
            '</div>',
          '</div>',

          '<div class="cmd-card" title="Linux / macOS" role="listitem">',
            '<div class="cmd-meta">',
              '<div class="cmd-title">Linux / macOS</div>',
              '<div class="cmd-line">',
                `<div id="cmdUnix" class="cmd-block" aria-label="Unix command">${escapedUnix}</div>`,
                '<button class="copy-small" onclick="copyCommand(\'cmdUnix\', this)" aria-label="Copy Unix command">Copy</button>',
              '</div>',
            '</div>',
          '</div>',

        '</div>',

        '<div class="instruction-note">Replace <code>your_command_here</code> with the command you use to run your app (for example: <code>npm start</code>, <code>vite</code>, <code>go run main.go</code>). Replace <code>file_name</code> with any log file name you want. The file will be created in your project root and will continuously capture terminal output.</div>',
      '</div>',

      // Config card
      '<div class="config-card">',
        '<h3>🔐 Secure identity</h3>',
        '<label>User ID (read-only)</label>',
        `<input id="userId" type="text" value="${this._escapeHtml(userId)}" readonly />`,
        '<div class="small-muted">This ID is auto-generated and stored securely.</div>',
        '<h3 style="margin-top:10px;">API Key (secure)</h3>',
        '<label>API Key</label>',
        `<input id="apiKey" type="text" placeholder="${apiKeySaved ? '•••••••• (saved)' : 'Paste API key here'}" />`,
        '<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">',
          '<button onclick="saveApiKey()">Save API Key</button>',
          '<button class="secondary" onclick="deleteApiKey()">Delete API Key</button>',
        '</div>',
      '</div>',

      // Log configuration (Fetch removed, Start/Stop renamed)
      '<div class="config-card">',
        '<h3>⚙️ Log configuration</h3>',
        '<form id="logConfigForm" onsubmit="return false;">',
          '<label>App name<input id="id" type="text" placeholder="e.g. banking" /></label>',
          '<label>Log type<input id="logType" type="text" placeholder="e.g. app" /></label>',
          '<div class="controls">',
            '<button type="button" id="startStreamBtn" class="poll-start disabled" disabled onclick="startStreaming()">Stream logs</button>',
            '<button type="button" id="stopStreamBtn" class="poll-stop disabled" disabled onclick="stopStreaming()">Stop stream</button>',
            '<button type="button" id="copyAllBtn" class="copy-btn disabled" disabled onclick="copyAll()">Copy all</button>',
          '</div>',
          '<div class="muted" style="margin-top:8px;">Calls every 4s: <code>http://localhost:8080/stream/ingest?app_name=APP&log_type=LOG</code></div>',
        '</form>',
      '</div>',

      // Live logs
      '<div class="config-card">',
        '<h3>📥 Live logs</h3>',
        '<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">',
          '<button id="analyzeBtn" class="btn" style="display:none;" onclick="requestAnalyze()">Analyze</button>',
          '<div id="analyzeStatus" class="muted" style="font-size:12px; min-height:18px;"></div>',
        '</div>',
        '<div id="logsContainer"><div id="logsEmpty" class="muted">(no logs yet)</div></div>',
      '</div>',

      // Analysis
      '<div class="config-card">',
        '<h3>🧠 Analysis</h3>',
        '<div id="analysisContainer"><div id="analysisEmpty" class="muted">(analysis results will appear here)</div></div>',
      '</div>',

      // Script
      '<script>',
        'const vscode = acquireVsCodeApi();',

        'const appInput = document.getElementById("id");',
        'const logInput = document.getElementById("logType");',
        'const startStreamBtn = document.getElementById("startStreamBtn");',
        'const stopStreamBtn = document.getElementById("stopStreamBtn");',
        'const copyAllBtn = document.getElementById("copyAllBtn");',

        'function enableButton(btn){ if(btn){ btn.disabled=false; btn.classList.remove("disabled"); }}',
        'function disableButton(btn){ if(btn){ btn.disabled=true; btn.classList.add("disabled"); }}',

        'function inputsFilled(){',
          'const app=(appInput.value||"").trim();',
          'const log=(logInput.value||"").trim();',
          'return app!=="" && log!=="";',
        '}',

        'function validateConfigInputs(){',
          'if (window._streamRunning) {',
            'disableButton(startStreamBtn);',
            'enableButton(stopStreamBtn);',
            'enableButton(copyAllBtn);',
            'return;',
          '}',
          'if (inputsFilled()) {',
            'enableButton(startStreamBtn);',
            'disableButton(stopStreamBtn);',
            'enableButton(copyAllBtn);',
          '} else {',
            'disableButton(startStreamBtn);',
            'disableButton(stopStreamBtn);',
            'disableButton(copyAllBtn);',
          '}',
        '}',

        'appInput.addEventListener("input", validateConfigInputs);',
        'logInput.addEventListener("input", validateConfigInputs);',

        'window._streamRunning=false;',

        // Stream start: do NOT clear previous logs; start 4s interval in extension
        'function startStreaming(){',
          'const app=appInput.value||"";',
          'const log=logInput.value||"";',
          'if(!app || !log){ vscode.postMessage({ command:"showError", message:"App name and log type are required to stream." }); return; }',
          'disableButton(startStreamBtn);',
          'enableButton(stopStreamBtn);',
          'window._streamRunning=true;',
          'setAnalyzeStatus("Streaming… calling ingest every 4 seconds");',
          'vscode.postMessage({ command:"startStream", app, log });',
        '}',

        'function stopStreaming(){',
          'vscode.postMessage({ command:"stopStream" });',
          'window._streamRunning=false;',
          'disableButton(stopStreamBtn);',
          'if (inputsFilled()) { enableButton(startStreamBtn); enableButton(copyAllBtn); } else { disableButton(startStreamBtn); disableButton(copyAllBtn); }',
          'setAnalyzeStatus("Stream stopped");',
        '}',

        'function copyAll(){',
          'const c=document.getElementById("logsContainer");',
          'const text=c.innerText||c.textContent||"";',
          'if(navigator.clipboard&&navigator.clipboard.writeText){',
            'navigator.clipboard.writeText(text).then(function(){',
              'const btn=document.getElementById("copyAllBtn");',
              'if(btn){ const orig=btn.textContent; btn.textContent="Copied"; setTimeout(function(){ btn.textContent=orig; },1200); }',
            '}).catch(function(){});',
          '}',
        '}',

        'function copyCommand(elementId, btnEl){',
          'const el=document.getElementById(elementId); if(!el) return;',
          'const cmd=el.innerText||el.textContent||""; if(!cmd) return;',
          'if(navigator.clipboard&&navigator.clipboard.writeText){',
            'navigator.clipboard.writeText(cmd).then(function(){',
              'if(btnEl){ const orig=btnEl.textContent; btnEl.textContent="Copied!"; setTimeout(function(){ btnEl.textContent=orig; },1200); }',
            '}).catch(function(){});',
          '}',
        '}',

        'function updateAnalyzeVisibility(){',
          'const c=document.getElementById("logsContainer");',
          'const analyzeBtn=document.getElementById("analyzeBtn");',
          'if(!c||!analyzeBtn) return;',
          'const children=Array.prototype.slice.call(c.children||[]);',
          'const meaningfulChildren=children.filter(ch=>!(ch.id==="logsEmpty"));',
          'analyzeBtn.style.display = meaningfulChildren.length===0 ? "none" : "inline-block";',
        '}',

        'function setAnalyzeStatus(text){ const el=document.getElementById("analyzeStatus"); if(el) el.textContent = text || ""; }',

        'function requestAnalyze(){',
          'const btn=document.getElementById("analyzeBtn"); if(btn){ btn.disabled=true; btn.textContent="Analyzing..."; }',
          'setAnalyzeStatus("Sending logs for analysis...");',
          'const a=document.getElementById("analysisContainer"); if(a) a.innerHTML=\'<div class="muted">Analyzing…</div>\';',
          'vscode.postMessage({ command:"analyzeLogsRequest" });',
        '}',

        // Render objects: only level (badge), timestamp (meta), message
        'function renderObjects(entries){',
          'const c=document.getElementById("logsContainer");',
          'const empty=document.getElementById("logsEmpty"); if(empty) empty.remove();',
          'for(let i=0;i<entries.length;i++){',
            'const e=entries[i]||{};',
            'const raw = e.raw || "";',
            'const severity = (e.severity||"INFO").toUpperCase();',
            'const ts = e.timestamp || "";',
            'const row=document.createElement("div"); row.className="log-row";',
            'const badge=document.createElement("div"); const badgeClass = "badge-" + (severity.replace(/[^A-Z]/g,"")||"INFO");',
            'badge.className = "log-badge " + badgeClass; badge.textContent = severity; row.appendChild(badge);',
            'const body=document.createElement("div"); body.className="log-body";',
            'const meta=document.createElement("div"); meta.className="log-meta";',
            'const tsSpan=document.createElement("div"); tsSpan.textContent = ts || "—";',
            'meta.appendChild(tsSpan);',
            'const msg=document.createElement("div"); msg.className="log-message"; msg.textContent = raw;',
            'body.appendChild(meta); body.appendChild(msg); row.appendChild(body); c.appendChild(row);',
          '}',
          'c.scrollTop = c.scrollHeight;',
          'updateAnalyzeVisibility();',
        '}',

        'function appendPlainText(text){',
          'const c=document.getElementById("logsContainer");',
          'const empty=document.getElementById("logsEmpty"); if(empty) empty.remove();',
          'const lines = (""+text).split(/\\r?\\n/);',
          'for(let i=0;i<lines.length;i++){ const ln=lines[i]; if(ln==="") continue;',
            'const div=document.createElement("div");',
            'const lower=ln.toLowerCase(); div.className="log-row";',
            'if(lower.indexOf("error")!==-1||lower.indexOf("exception")!==-1||lower.indexOf("caused by")!==-1){',
              'div.innerHTML = \'<div class="log-badge badge-ERROR">ERROR</div><div class="log-body"><div class="log-meta"><div>—</div></div><div class="log-message">\' + (ln) + \'</div></div>\';',
            '} else if(lower.indexOf("warn")!==-1||lower.indexOf("warning")!==-1){',
              'div.innerHTML = \'<div class="log-badge badge-WARN">WARN</div><div class="log-body"><div class="log-meta"><div>—</div></div><div class="log-message">\' + (ln) + \'</div></div>\';',
            '} else {',
              'div.innerHTML = \'<div class="log-badge badge-INFO">INFO</div><div class="log-body"><div class="log-meta"><div>—</div></div><div class="log-message">\' + (ln) + \'</div></div>\';',
            '}',
            'c.appendChild(div);',
          '}',
          'c.scrollTop = c.scrollHeight; updateAnalyzeVisibility();',
        '}',

        // Analysis rendering and diff/apply handlers (unchanged)
        'function renderAnalysisResult(result){',
          'const a=document.getElementById("analysisContainer"); if(!a) return; a.innerHTML="";',
          'const recs=(result&&Array.isArray(result.recommendations))?result.recommendations:[];',
          'if(recs.length===0){ const empty=document.createElement("div"); empty.className="muted"; empty.textContent="(no recommendations returned)"; a.appendChild(empty); }',
          'else {',
            'const grid=document.createElement("div"); grid.className="analysis-grid";',
            'recs.forEach((r,i)=>{',
              'const card=document.createElement("div"); card.className="analysis-card"; card.dataset.recIndex=i;',
              'const title=document.createElement("div"); title.className="analysis-title"; title.textContent = r.title || "Recommendation";',
              'const desc=document.createElement("div"); desc.className="analysis-desc"; desc.textContent = r.description || "";',
              'const actions=document.createElement("div"); actions.style.display="flex"; actions.style.gap="8px"; actions.style.alignItems="center";',
              'const sevBadge=document.createElement("div"); const sev=(r.severity||"LOW").toUpperCase();',
              'sevBadge.className="severity-badge severity-"+sev; sevBadge.textContent=sev;',
              'const applyBtn=document.createElement("button"); applyBtn.className="rec-apply"; applyBtn.textContent="Apply";',
              'applyBtn.onclick=()=>{ applyBtn.disabled=true; applyBtn.textContent="Applying..."; vscode.postMessage({ command:"applyRecommendation", recommendation: r }); };',
              'const diffBtn=document.createElement("button"); diffBtn.className="rec-diff"; diffBtn.textContent="Diff";',
              'diffBtn.onclick=()=>{ const oldCode=["// old version","function greet(name) {","  console.log(\\"Hello \\" + name);","}","","greet(\\"world\\");"].join("\\n"); const newCode=["// new version","function greet(name) {","  // improved greeting","  console.log(\\"Hello, \\" + name + \\"!\\");","}","","greet(\\"world\\");"].join("\\n"); vscode.postMessage({ command:"showDiff", left: oldCode, right: newCode, title: r.title || "code-diff" }); };',
              'const ignoreBtn=document.createElement("button"); ignoreBtn.className="rec-ignore"; ignoreBtn.textContent="Ignore"; ignoreBtn.onclick=()=>{ card.remove(); };',
              'actions.appendChild(sevBadge); actions.appendChild(applyBtn); actions.appendChild(diffBtn); actions.appendChild(ignoreBtn);',
              'card.appendChild(title); card.appendChild(desc); card.appendChild(actions); grid.appendChild(card);',
            '}); a.appendChild(grid);',
          '}',
          'const btn=document.getElementById("analyzeBtn"); if(btn){ btn.disabled=false; btn.textContent="Analyze"; } setAnalyzeStatus("Analysis complete");',
        '}',

        'function renderApplyResult(response){',
          'const a=document.getElementById("analysisContainer"); if(!a) return;',
          'const card=document.createElement("div"); card.className="apply-result";',
          'const icon=document.createElement("div"); icon.className="apply-icon"; icon.innerHTML = \'<svg viewBox="0 0 24 24" fill="none"><path d="M9 12.5L11.5 15L15 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12C21 17.5228 16.5228 22 11 22C5.47715 22 1 17.5228 1 12C1 6.47715 5.47715 2 11 2C16.5228 2 21 6.47715 21 12Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>\';',
          'const body=document.createElement("div"); body.style.flex="1";',
          'const title=document.createElement("div"); title.className="apply-title"; title.textContent = (response && response.status && String(response.status).toLowerCase()==="success") ? "Applied Successfully" : "Apply Result";',
          'const message=document.createElement("div"); message.className="apply-message"; message.textContent = response && response.message ? response.message : JSON.stringify(response);',
          'const meta=document.createElement("div"); meta.className="apply-meta";',
          'const badge=document.createElement("div"); badge.className="apply-badge"; badge.textContent = response && response.status ? String(response.status).toUpperCase() : "UNKNOWN";',
          'const ts=document.createElement("div"); ts.className="small-muted"; ts.textContent = new Date().toLocaleString();',
          'meta.appendChild(badge); meta.appendChild(ts);',
          'const actions=document.createElement("div"); actions.className="apply-actions";',
          'const copyBtn=document.createElement("button"); copyBtn.className="btn-copy"; copyBtn.textContent="Copy JSON";',
          'copyBtn.onclick=function(){ const payload=JSON.stringify(response,null,2); navigator.clipboard && navigator.clipboard.writeText(payload).then(function(){ copyBtn.textContent="Copied"; setTimeout(function(){ copyBtn.textContent="Copy JSON"; },1200); }).catch(function(){}); };',
          'const closeBtn=document.createElement("button"); closeBtn.className="btn-close"; closeBtn.textContent="Dismiss"; closeBtn.onclick=function(){ card.remove(); };',
          'actions.appendChild(copyBtn); actions.appendChild(closeBtn);',
          'body.appendChild(title); body.appendChild(message); body.appendChild(meta); body.appendChild(actions);',
          'card.appendChild(icon); card.appendChild(body);',
          'a.insertBefore(card, a.firstChild); card.scrollIntoView({ behavior: "smooth", block: "start" });',
        '}',

        'function handleApplySuccess(recommendation, response){ renderApplyResult(response); const applyBtns=document.querySelectorAll(".rec-apply"); applyBtns.forEach(b=>{ b.disabled=false; b.textContent="Apply"; }); }',
        'function handleApplyError(recommendation, errorText){ const a=document.getElementById("analysisContainer"); if(!a) return; const errCard=document.createElement("div"); errCard.className="analysis-card"; const title=document.createElement("div"); title.className="analysis-title"; title.textContent="Apply Error"; const content=document.createElement("div"); content.className="muted"; content.textContent = "" + errorText; errCard.appendChild(title); errCard.appendChild(content); a.insertBefore(errCard, a.firstChild); const applyBtns=document.querySelectorAll(".rec-apply"); applyBtns.forEach(b=>{ b.disabled=false; b.textContent="Apply"; }); setAnalyzeStatus("Apply failed"); }',

        'window.addEventListener("message", function(event){',
          'var msg = event.data; if(!msg) return;',
          'if(msg.type==="logsObjects"){ renderObjects(msg.entries||[]); }',
          'else if(msg.type==="logsObjectsAppend"){ renderObjects(msg.entries||[]); }',
          'else if(msg.type==="logsAppend"){ appendPlainText(msg.chunk||""); }',
          'else if(msg.type==="clearLogs"){ const c=document.getElementById("logsContainer"); c.innerHTML=\'<div id="logsEmpty" class="muted">(no logs yet)</div>\'; updateAnalyzeVisibility(); }',
          'else if(msg.type==="analysisResult"){ renderAnalysisResult(msg.result); }',
          'else if(msg.type==="analysisError"){ const a=document.getElementById("analysisContainer"); if(a) a.innerHTML = \'<div class="analysis-card"><div class="analysis-title">Analysis Error</div><div class="muted">\' + (msg.error||"Unknown error") + \'</div></div>\'; }',
          'else if(msg.type==="analysisClear"){ const a=document.getElementById("analysisContainer"); if(a) a.innerHTML = \'<div id="analysisEmpty" class="muted">(analysis results will appear here)</div>\'; }',
        '});',

        'validateConfigInputs(); setTimeout(updateAnalyzeVisibility,200);',
      '</script>',
      '</body>',
      '</html>'
    ].join('\n');

    return html;
  }

  _getStyle() {
    return `
    <style>
      :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-textLink-foreground);
        --border: var(--vscode-input-border);
        --card-bg: rgba(0,0,0,0.02);
        --success: #2ecc71;
        --danger: #e74c3c;
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        font-family: "Segoe UI", sans-serif;
        margin: 0;
        padding: 12px;
        color: var(--fg);
        background-color: var(--bg);
      }
      h2 { color: var(--accent); margin: 0 0 12px 0; font-size: 16px; }
      h3 { margin: 0 0 8px 0; font-size: 15px; }

      label { display:block; margin-top:8px; font-weight: 500; }
      input, select, textarea {
        width:100%; padding:8px; margin-top:6px;
        border:1px solid var(--border); border-radius:6px;
        font-size:13px; color:var(--fg); background-color:var(--bg);
      }
      button {
        padding:8px 12px; border-radius:8px; cursor:pointer;
        background:var(--accent); color:var(--bg); border:none; font-weight:600;
      }
      button.secondary { background:transparent; color:var(--accent); border:1px solid var(--border); }

      .config-card {
        border:1px solid var(--border); border-radius:10px;
        padding:12px; margin-top:12px; background-color:var(--card-bg);
      }
      .muted { color: var(--muted); font-size:12px; margin-top:6px; }
      .small-muted { color:var(--muted); font-size:12px; }

      .controls { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; align-items:center; }
      .copy-btn { padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--accent); cursor:pointer; font-weight:600; }
      .btn { padding:8px 12px; border-radius:8px; border:none; cursor:pointer; font-weight:700; }

      .poll-start { background: linear-gradient(90deg, #2ecc71, #27ae60); color: white; }
      .poll-stop { background: transparent; color: var(--danger); border:1px solid rgba(231,76,60,0.35); }

      .disabled { opacity: 0.55; pointer-events: none; }

      .instruction-banner {
        border:1px solid var(--border); border-radius:10px; padding:12px;
        background: linear-gradient(180deg, rgba(0,0,0,0.015), rgba(0,0,0,0.01));
        display:flex; flex-direction:column; gap:10px; overflow:hidden; width:100%;
      }
      .instruction-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
      .instruction-body { color:var(--muted); font-size:12.5px; line-height:1.4; }

      .instruction-commands {
        display:grid; grid-template-columns: repeat(2, minmax(260px, 1fr)); gap:10px; width:100%;
      }
      @media (max-width:860px) { .instruction-commands { grid-template-columns: 1fr; } }

      .cmd-card {
        background: rgba(0,0,0,0.02);
        border:1px solid rgba(0,0,0,0.08);
        padding:10px; border-radius:10px;
        display:flex; gap:10px; align-items:center; width:100%;
      }
      .cmd-meta { display:flex; flex-direction:column; gap:6px; flex:1; min-width:0; }
      .cmd-title { font-weight:700; font-size:13px; color:var(--accent); }
      .cmd-line { display:flex; gap:8px; align-items:center; width:100%; }
      .cmd-block {
        font-family: "Consolas", monospace; font-size:13px;
        background: rgba(0,0,0,0.01); padding:8px; border-radius:8px;
        border:1px dashed rgba(0,0,0,0.08); white-space:pre-wrap; color:var(--fg);
        overflow:auto; max-height:120px; flex:1;
      }
      .copy-small { padding:8px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.08); background:transparent; color:var(--accent); cursor:pointer; font-weight:700; height:36px; align-self:center; }

      #logsContainer {
        width:100%; max-height:38vh; overflow:auto; padding:10px; border-radius:10px;
        background: linear-gradient(180deg, rgba(0,0,0,0.01), rgba(0,0,0,0.00));
        border:1px solid var(--border); display:flex; flex-direction:column; gap:8px;
      }
      .log-row {
        display:flex; gap:12px; align-items:flex-start; padding:10px; border-radius:8px;
        background: rgba(0,0,0,0.01); border:1px solid rgba(0,0,0,0.06);
      }
      .log-badge { min-width:68px; padding:6px 10px; border-radius:6px; font-weight:700; font-family:"Consolas", monospace; font-size:12px; text-align:center; }
      .badge-DEBUG { background: rgba(100,100,255,0.06); color: #3b4cca; border:1px solid rgba(59,76,202,0.12); }
      .badge-INFO  { background: rgba(0,200,150,0.06); color: #00796b; border:1px solid rgba(0,121,107,0.12); }
      .badge-WARN  { background: rgba(181,137,0,0.06); color: #b58900; border:1px solid rgba(181,137,0,0.12); }
      .badge-ERROR { background: rgba(255,107,107,0.06); color: #c0392b; border:1px solid rgba(192,57,43,0.12); }
      .log-body { flex:1; display:flex; flex-direction:column; gap:6px; min-width:0; }
      .log-meta { display:flex; gap:12px; align-items:center; color:var(--muted); font-size:12px; }
      .log-message { font-family:"Consolas","Courier New", monospace; font-size:13px; color:var(--fg); white-space:pre-wrap; word-break:break-word; }

      #analysisContainer {
        width:100%; max-height:40vh; overflow:auto; padding:10px; border-radius:10px;
        background: linear-gradient(180deg, rgba(0,0,0,0.01), rgba(0,0,0,0.00));
        border:1px solid var(--border); display:flex; flex-direction:column; gap:10px;
      }
      .analysis-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; align-items:start; }
      .analysis-card { background: rgba(255,255,255,0.01); border-radius:10px; padding:12px; border:1px solid rgba(0,0,0,0.08); display:flex; flex-direction:column; gap:8px; }
      .analysis-title { font-weight:700; color:var(--accent); font-size:14px; display:flex; align-items:center; gap:8px; }
      .analysis-desc { color:var(--fg); font-size:13px; line-height:1.35; white-space:pre-wrap; }
      .severity-badge { padding:6px 8px; border-radius:999px; font-weight:700; font-family:"Consolas", monospace; font-size:12px; display:inline-flex; align-items:center; gap:8px; }
      .severity-LOW { background: rgba(108,117,125,0.08); color:#6c757d; border:1px solid rgba(108,117,125,0.12); }
      .severity-MEDIUM { background: rgba(243,156,18,0.08); color:#f39c12; border:1px solid rgba(243,156,18,0.12); }
      .severity-HIGH { background: rgba(231,76,60,0.08); color:#e74c3c; border:1px solid rgba(231,76,60,0.12); }
      .rec-apply { background: var(--success); color:#fff; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; }
      .rec-diff  { background: transparent; color: var(--accent); border:1px solid rgba(0,0,0,0.08); padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; }
      .rec-ignore{ background:transparent; color: var(--danger); border:1px solid rgba(231,76,60,0.35); padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; }

      .apply-result { display:flex; gap:10px; align-items:flex-start; border:1px solid rgba(0,0,0,0.08); border-radius:10px; padding:10px; }
      .apply-icon { width:36px; color: var(--accent); }
      .apply-title { font-weight:700; color:var(--accent); margin-bottom:6px; }
      .apply-message { font-size:13px; color:var(--fg); word-break:break-word; }
      .apply-meta { display:flex; gap:10px; align-items:center; margin-top:6px; }
      .apply-badge { padding:4px 8px; border-radius:999px; border:1px solid rgba(0,0,0,0.15); font-size:12px; }
      .apply-actions { display:flex; gap:8px; margin-top:8px; }
      .btn-copy, .btn-close { padding:6px 10px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--accent); cursor:pointer; font-weight:700; }
    </style>
    `;
  }

  async resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };

    await this._initSecretsPromise;
    webviewView.webview.html = await this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.command) {
          case 'saveApiKey': {
            const key = (message.key || '').trim();
            if (!key) {
              vscode.window.showErrorMessage('API key cannot be empty.');
              return;
            }
            try {
              await this.saveApiKey(key);
              vscode.window.showInformationMessage('API key saved securely.');
              webviewView.webview.html = await this.getHtml();
            } catch (e) {
              vscode.window.showErrorMessage('Failed to save API key: ' + (e && e.message ? e.message : String(e)));
            }
            break;
          }

          case 'deleteApiKey': {
            try {
              await this.deleteApiKey();
              vscode.window.showInformationMessage('API key removed.');
              webviewView.webview.html = await this.getHtml();
            } catch (e) {
              vscode.window.showErrorMessage('Failed to delete API key: ' + (e && e.message ? e.message : String(e)));
            }
            break;
          }

          case 'startStream': {
            const app = message.app || '';
            const log = message.log || '';
            if (!app || !log) {
              vscode.window.showErrorMessage('App name and log type are required to stream.');
              return;
            }
            this._startStreaming(app, log);
            break;
          }

          case 'stopStream': {
            this._stopStreaming();
            break;
          }

          case 'analyzeLogsRequest': {
            try {
              const res = await this._sendAnalyzeRequestUsingStoredLogs();
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'analysisResult', result: res.body });
              }
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'analysisError', error: errMsg });
              }
            }
            break;
          }

          case 'applyRecommendation': {
            const rec = message.recommendation || null;
            if (!rec) {
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'applyError', recommendation: rec, error: 'No recommendation provided' });
              }
              return;
            }
            try {
              const res = await this._applyRecommendation(rec);
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'applyResult', recommendation: rec, response: res.body });
              }
            } catch (err) {
              const errMsg = err && err.message ? err.message : String(err);
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'applyError', recommendation: rec, error: errMsg });
              }
            }
            break;
          }

          case 'showDiff': {
            const leftContent = typeof message.left === 'string' ? message.left : [
              '// old version (dummy)',
              'function greet(name) {',
              '  console.log("Hello " + name);',
              '}',
              '',
              'greet("world");'
            ].join('\n');

            const rightContent = typeof message.right === 'string' ? message.right : [
              '// new version (dummy)',
              'function greet(name) {',
              '  // improved greeting',
              '  console.log("Hello, " + name + "!");',
              '}',
              '',
              'greet("world");'
            ].join('\n');

            const title = message.title || 'Code Diff';

            try {
              const leftDoc = await vscode.workspace.openTextDocument({ content: leftContent, language: 'javascript' });
              const rightDoc = await vscode.workspace.openTextDocument({ content: rightContent, language: 'javascript' });
              await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, `${title} — Diff`);
            } catch (e) {
              vscode.window.showErrorMessage('Failed to open diff: ' + (e && e.message ? e.message : String(e)));
            }
            break;
          }

          case 'showError': {
            const msg = message.message || 'Error';
            vscode.window.showErrorMessage(msg);
            break;
          }

          default:
            console.warn('Unknown message from webview:', message);
        }
      } catch (e) {
        console.error('Error handling webview message:', e);
      }
    });
  }

  showConfigUI() {
    if (this.webviewView) {
      this._initSecretsPromise.then(async () => {
        this.webviewView.webview.html = await this.getHtml();
      });
    }
  }

  dispose() {
    this._stopStreaming();
    this.webviewView = null;
    this._lastSentConfig = null;
    this._lastFetchedLogs = [];
  }
}

module.exports = { activate, deactivate };
