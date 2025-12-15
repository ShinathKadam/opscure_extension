// opscure-log-fetcher.js
// VS Code extension (plain JavaScript).
// Full extension implementing:
//  - Instruction banner with Windows and Linux/macOS commands (command + copy button on single line)
//  - Fetch logs via /logs?app=...&log=...&lines=... (Fetch Log button)
//  - Start Live / Stop Live buttons: extension polls /logs every 1s and replaces logs while live
//  - When Start Live is clicked: clear previously fetched logs (extension + UI) and store only latest polled logs
//  - Buttons disabled until required config fields are filled; Start Live disables Fetch until Stop Live clicked
//  - Analyze logs (POST /logs/analyze) using stored logs and saved OpenAI API key
//  - Apply recommendation (POST /logs/apply-patch)
//  - Secure API key storage via VS Code secrets
//  - Responsive layout and styling; command + copy button aligned in a single line
//
// Requirements:
//  - Add "axios" to extension dependencies in package.json
//  - Register the webview view id 'logFetcherView' in package.json contributes.views

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
    this._lastFetchedLogs = []; // always an array
    this._pollInterval = null;
    this._polling = false;
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

  // Fetch logs via GET with query params (used by Fetch Log button)
  async _fetchLogsViaQuery(appName, logType, lines) {
    const out = vscode.window.createOutputChannel('OPSCURE:logs');
    out.show(true);

    try {
      const base = 'http://127.0.0.1:8080/logs';
      const params = new URL(base);
      params.searchParams.set('app', '' + appName);
      params.searchParams.set('log', '' + logType);
      params.searchParams.set('lines', '' + lines);

      const finalUrl = params.toString();

      out.appendLine('=== Fetch Logs (query) Request ===');
      out.appendLine(finalUrl);
      out.appendLine('==================================');

      const resp = await axios.get(finalUrl, {
        timeout: 15000,
        responseType: 'text',
        validateStatus: null,
      });

      const status = resp.status || 0;
      const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      out.appendLine('Response ' + status + ': ' + (bodyText.length > 400 ? bodyText.slice(0, 400) + '…' : bodyText));

      if (status >= 200 && status < 300) {
        // Try parse JSON
        let parsed = null;
        try {
          parsed = JSON.parse(bodyText);
        } catch (e) {
          parsed = null;
        }

        // Normalize and store
        let entries = [];
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(it => it && typeof it === 'object' && ('raw' in it))) {
          entries = parsed;
        } else if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
          entries = parsed.map(s => ({ raw: s, severity: 'INFO', type: 'raw' }));
        } else if (parsed !== null && typeof parsed === 'object') {
          entries = [ parsed ];
        } else {
          const linesArr = ('' + bodyText).split(/\r?\n/).filter(l => l && l.trim());
          entries = linesArr.map(s => ({ raw: s, severity: 'INFO', type: 'raw' }));
        }

        this._lastFetchedLogs = entries.slice();
        if (this.webviewView) {
          this.webviewView.webview.postMessage({ type: 'logsObjects', entries });
        }
      } else {
        if (this.webviewView) {
          this.webviewView.webview.postMessage({ type: 'logsAppend', chunk: '\n[fetch failed ' + status + '] ' + bodyText + '\n' });
        }
        throw new Error('Server responded ' + status + ': ' + bodyText);
      }
    } catch (err) {
      out.appendLine('Fetch logs error: ' + String(err));
      throw err;
    }
  }

  // Analyze using stored logs
  async _sendAnalyzeRequestUsingStoredLogs() {
    const out = vscode.window.createOutputChannel('OPSCURE:analyze');
    out.show(true);

    try {
      if (!this._apiKey) {
        throw new Error('OpenAI API key not set. Save it in the API Key field first.');
      }

      if (!Array.isArray(this._lastFetchedLogs) || this._lastFetchedLogs.length === 0) {
        throw new Error('No fetched logs available to analyze. Fetch logs first or start live.');
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

  // Apply recommendation
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

  // Start extension-side polling (calls /logs every 1s)
  _startExtensionPolling(app, log, lines) {
    if (this._polling) return;
    this._polling = true;
    this._lastSentConfig = { app, log, lines };

    const out = vscode.window.createOutputChannel('OPSCURE:poll');
    out.show(true);
    out.appendLine(`Starting extension-side polling: app=${app} log=${log} lines=${lines}`);

    this._pollInterval = setInterval(async () => {
      try {
        const base = 'http://127.0.0.1:8080/logs';
        const params = new URL(base);
        params.searchParams.set('app', '' + app);
        params.searchParams.set('log', '' + log);
        params.searchParams.set('lines', '' + lines);

        const resp = await axios.get(params.toString(), { timeout: 8000, validateStatus: null });

        if (!resp || resp.status < 200 || resp.status >= 300) {
          const text = resp && resp.data ? (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)) : 'no response';
          out.appendLine(`[poll error ${resp ? resp.status : 'no-status'}] ${text}`);
          if (this.webviewView) {
            this.webviewView.webview.postMessage({ type: 'logsAppend', chunk: `[poll error ${resp ? resp.status : 'no-status'}] ${text}` });
          }
          return;
        }

        const content = resp.data;
        let entries = [];

        if (Array.isArray(content) && content.length > 0 && content.every(it => it && typeof it === 'object' && ('raw' in it))) {
          entries = content;
        } else if (Array.isArray(content) && content.every(it => typeof it === 'string')) {
          entries = content.map(s => ({ raw: s, severity: 'INFO', type: 'raw' }));
        } else if (typeof content === 'string') {
          const linesArr = content.split(/\r?\n/).filter(l => l && l.trim());
          entries = linesArr.map(s => ({ raw: s, severity: 'INFO', type: 'raw' }));
        } else if (content && typeof content === 'object') {
          entries = [content];
        }

        // Replace previous logs entirely with latest polled logs
        if (entries.length > 0) {
          this._lastFetchedLogs = entries.slice();
          if (this.webviewView) {
            this.webviewView.webview.postMessage({ type: 'polledToWebview', entries: entries });
          }
        }
      } catch (err) {
        out.appendLine('[poll exception] ' + (err && err.message ? err.message : String(err)));
        if (this.webviewView) {
          this.webviewView.webview.postMessage({ type: 'logsAppend', chunk: '[poll exception] ' + (err && err.message ? err.message : String(err)) });
        }
      }
    }, 1000);
  }

  // Stop extension-side polling
  _stopExtensionPolling() {
    if (!this._polling) return;
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._polling = false;
    const out = vscode.window.createOutputChannel('OPSCURE:poll');
    out.show(true);
    out.appendLine('Stopped extension-side polling');
  }

  // CSS and HTML builder
  getCommonStyle() {
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

      /* Instruction banner */
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
      @media (max-width:860px) {
        .instruction-commands { grid-template-columns: 1fr; }
      }

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

      /* Logs */
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
      .badge-INFO { background: rgba(0,200,150,0.06); color: #00796b; border:1px solid rgba(0,121,107,0.12); }
      .badge-WARN { background: rgba(181,137,0,0.06); color: #b58900; border:1px solid rgba(181,137,0,0.12); }
      .badge-ERROR { background: rgba(255,107,107,0.06); color: #c0392b; border:1px solid rgba(192,57,43,0.12); }
      .log-body { flex:1; display:flex; flex-direction:column; gap:6px; min-width:0; }
      .log-meta { display:flex; gap:12px; align-items:center; color:var(--muted); font-size:12px; }
      .log-message { font-family:"Consolas","Courier New", monospace; font-size:13px; color:var(--fg); white-space:pre-wrap; word-break:break-word; }

      /* Analysis */
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
      .rec-ignore { background:transparent; color: var(--danger); border:1px solid rgba(231,76,60,0.35); padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:700; }

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

  // Build the full HTML for the webview
  async getHtml() {
    await this._initSecretsPromise;
    const style = this.getCommonStyle();
    const userId = this._userId || '(generating...)';
    const apiKeySaved = !!this._apiKey;

    const windowsCmd = 'your_command_here | Tee-Object -FilePath file_name.log';
    const unixCmd = 'your_command_here 2>&1 | tee -a file_name.log';

    const instructionText = `
If your app is running locally and you are not storing live logs in a log file, first stop/kill the currently running server.
Then run one of the commands below to capture live terminal output to a file in your project root.
When you restart the server, run the same command again to resume capturing.
`.trim();

    const escapedInstruction = this._escapeHtml(instructionText);
    const escapedWindows = this._escapeHtml(windowsCmd);
    const escapedUnix = this._escapeHtml(unixCmd);

    return `
    <html><head>${style}</head><body>
      <h2>OPSCURE Log Fetcher</h2>

      <div class="instruction-banner" role="region" aria-label="Log capture instructions">
        <div class="instruction-head">
          <div style="flex:1; min-width:0;">
            <strong>Capture live logs to a file</strong>
            <div class="instruction-body">${escapedInstruction}</div>
          </div>
          <div style="min-width:140px; text-align:right;">
            <div class="small-muted">Quick copy</div>
          </div>
        </div>

        <div class="instruction-commands" role="list">
          <div class="cmd-card" title="Windows PowerShell / CMD" role="listitem">
            <div class="cmd-meta">
              <div class="cmd-title">Windows (PowerShell / CMD)</div>
              <div class="cmd-line">
                <div id="cmdWin" class="cmd-block" aria-label="Windows command">${escapedWindows}</div>
                <button class="copy-small" onclick="copyCommand('cmdWin', this)" aria-label="Copy Windows command">Copy</button>
              </div>
            </div>
          </div>

          <div class="cmd-card" title="Linux / macOS" role="listitem">
            <div class="cmd-meta">
              <div class="cmd-title">Linux / macOS</div>
              <div class="cmd-line">
                <div id="cmdUnix" class="cmd-block" aria-label="Unix command">${escapedUnix}</div>
                <button class="copy-small" onclick="copyCommand('cmdUnix', this)" aria-label="Copy Unix command">Copy</button>
              </div>
            </div>
          </div>
        </div>

        <div class="instruction-note">
          Replace <code>your_command_here</code> with the command you use to run your app (for example: <code>npm start</code>, <code>vite</code>, <code>go run main.go</code>).
          Replace <code>file_name</code> with any log file name you want. The file will be created in your project root and will continuously capture terminal output.
        </div>
      </div>

      <div class="config-card">
        <h3>🔐 Secure Identity</h3>
        <label>User ID (read-only)</label>
        <input id="userId" type="text" value="${userId}" readonly />
        <div class="small-muted">This ID is auto-generated and stored securely.</div>

        <h3 style="margin-top:10px;">API Key (secure)</h3>
        <label>API Key</label>
        <input id="apiKey" type="text" placeholder="${apiKeySaved ? '•••••••• (saved)' : 'Paste API key here'}" />
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <button onclick="saveApiKey()">Save API Key</button>
          <button class="secondary" onclick="deleteApiKey()">Delete API Key</button>
        </div>
      </div>

      <div class="config-card">
        <h3>⚙️ Log Configuration</h3>
        <form id="logConfigForm" onsubmit="fetchLogs(); return false;">
          <label>App Name
            <input id="id" type="text" placeholder="e.g. banking" />
          </label>
          <label>Log Type
            <input id="logType" type="text" placeholder="e.g. app" />
          </label>
          <label>Lines
            <input id="lines" type="number" placeholder="e.g. 50" min="1" />
          </label>

          <div class="controls">
            <button type="submit" id="fetchBtn" class="btn disabled" disabled>Fetch Log</button>

            <button type="button" id="startLiveBtn" class="poll-start disabled" disabled onclick="startPolling()">Start Live</button>
            <button type="button" id="stopLiveBtn" class="poll-stop disabled" disabled onclick="stopPolling()">Stop Live</button>

            <button type="button" id="copyAllBtn" class="copy-btn disabled" disabled onclick="copyAll()">Copy All</button>
          </div>
        </form>
      </div>

      <div class="config-card">
        <h3>📥 Live Logs</h3>

        <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
          <button id="analyzeBtn" class="btn" style="display:none;" onclick="requestAnalyze()">Analyze</button>
          <div id="analyzeStatus" class="muted" style="font-size:12px; min-height:18px;"></div>
        </div>

        <div id="logsContainer">
          <div id="logsEmpty" class="muted">(no logs yet)</div>
        </div>
      </div>

      <div class="config-card">
        <h3>🧠 Analysis</h3>
        <div id="analysisContainer">
          <div id="analysisEmpty" class="muted">(analysis results will appear here)</div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        // Elements
        const appInput = document.getElementById('id');
        const logInput = document.getElementById('logType');
        const linesInput = document.getElementById('lines');
        const fetchBtn = document.getElementById('fetchBtn');
        const startLiveBtn = document.getElementById('startLiveBtn');
        const stopLiveBtn = document.getElementById('stopLiveBtn');
        const copyAllBtn = document.getElementById('copyAllBtn');

        function enableButton(btn) { if (btn) { btn.disabled = false; btn.classList.remove('disabled'); } }
        function disableButton(btn) { if (btn) { btn.disabled = true; btn.classList.add('disabled'); } }

        function inputsFilled() {
          const app = (appInput.value || '').trim();
          const log = (logInput.value || '').trim();
          const lines = (linesInput.value || '').trim();
          return app !== '' && log !== '' && lines !== '' && !isNaN(Number(lines)) && Number(lines) > 0;
        }

        function validateConfigInputs() {
          const valid = inputsFilled();
          if (valid) {
            enableButton(fetchBtn);
            enableButton(startLiveBtn);
            enableButton(copyAllBtn);
            if (!stopLiveBtn.dataset.forcedEnabled) disableButton(stopLiveBtn);
          } else {
            disableButton(fetchBtn);
            disableButton(startLiveBtn);
            disableButton(stopLiveBtn);
            disableButton(copyAllBtn);
          }
        }

        [appInput, logInput, linesInput].forEach(el => {
          el.addEventListener('input', () => {
            if (window._liveRunning) {
              disableButton(fetchBtn);
              disableButton(startLiveBtn);
              inputsFilled() ? enableButton(copyAllBtn) : disableButton(copyAllBtn);
              return;
            }
            validateConfigInputs();
          });
        });

        function saveApiKey(){ const key=document.getElementById('apiKey').value.trim(); vscode.postMessage({command:'saveApiKey', key}); }
        function deleteApiKey(){ vscode.postMessage({command:'deleteApiKey'}); }

        async function fetchLogs(){
          disableButton(fetchBtn);
          const app = appInput.value || '';
          const log = logInput.value || '';
          const lines = linesInput.value || '50';
          vscode.postMessage({command:'fetchLogs', app, log, lines});
          setTimeout(() => { if (!window._liveRunning) validateConfigInputs(); }, 600);
        }

        window._liveRunning = false;

        function startPolling() {
          const app = appInput.value || '';
          const log = logInput.value || '';
          const lines = linesInput.value || '50';
          if (!app || !log) {
            vscode.postMessage({ command: 'showError', message: 'App name and Log type are required to start live polling.' });
            return;
          }
          // Clear UI logs immediately
          const c = document.getElementById('logsContainer');
          c.innerHTML = '<div id="logsEmpty" class="muted">(no logs yet)</div>';
          // disable fetch/start; enable stop
          disableButton(fetchBtn);
          disableButton(startLiveBtn);
          enableButton(stopLiveBtn);
          stopLiveBtn.dataset.forcedEnabled = '1';
          window._liveRunning = true;
          setAnalyzeStatus('Live polling started');

          // Tell extension to clear previous logs and start polling
          vscode.postMessage({ command: 'startPolling', app, log, lines, clearPrevious: true });
        }

        function stopPolling() {
          vscode.postMessage({ command: 'stopPolling' });
          window._liveRunning = false;
          stopLiveBtn.dataset.forcedEnabled = '';
          validateConfigInputs();
          setAnalyzeStatus('Live polling stopped');
        }

        function copyAll() {
          const c = document.getElementById('logsContainer');
          const text = c.innerText || c.textContent || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function(){
              const btn = document.getElementById('copyAllBtn');
              if (btn) {
                const orig = btn.textContent;
                btn.textContent = 'Copied';
                setTimeout(function(){ btn.textContent = orig; }, 1200);
              }
            }).catch(function(){});
          }
        }

        function copyCommand(elementId, btnEl) {
          const el = document.getElementById(elementId);
          if (!el) return;
          const cmd = el.innerText || el.textContent || '';
          if (!cmd) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(function(){
              if (btnEl) {
                const orig = btnEl.textContent;
                btnEl.textContent = 'Copied!';
                setTimeout(function(){ btnEl.textContent = orig; }, 1200);
              }
            }).catch(function(){});
          }
        }

        function updateAnalyzeVisibility() {
          const c = document.getElementById('logsContainer');
          const analyzeBtn = document.getElementById('analyzeBtn');
          if (!c || !analyzeBtn) return;
          const children = Array.prototype.slice.call(c.children || []);
          const meaningfulChildren = children.filter(ch => !(ch.id === 'logsEmpty'));
          analyzeBtn.style.display = meaningfulChildren.length === 0 ? 'none' : 'inline-block';
        }

        function setAnalyzeStatus(text) {
          const el = document.getElementById('analyzeStatus');
          if (el) el.textContent = text || '';
        }

        function requestAnalyze() {
          const btn = document.getElementById('analyzeBtn');
          if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
          setAnalyzeStatus('Sending logs for analysis...');
          const a = document.getElementById('analysisContainer');
          if (a) a.innerHTML = '<div class="muted">Analyzing…</div>';
          vscode.postMessage({ command: 'analyzeLogsRequest' });
        }

        // Render helpers
        function renderObjects(entries) {
          const c = document.getElementById('logsContainer');
          const empty = document.getElementById('logsEmpty');
          if (empty) empty.remove();

          for (let i = 0; i < entries.length; i++) {
            const e = entries[i] || {};
            const raw = e.raw || (typeof e === 'string' ? e : '');
            const severity = (e.severity || 'INFO').toUpperCase();
            const type = e.type || '';

            const row = document.createElement('div');
            row.className = 'log-row';

            const badge = document.createElement('div');
            badge.className = 'log-badge badge-' + (severity.replace(/[^A-Z]/g,'') || 'INFO');
            badge.textContent = severity;
            row.appendChild(badge);

            const body = document.createElement('div');
            body.className = 'log-body';

            let timestamp = '';
            let message = raw;
            const tsMatch = raw.match(/^\\s*(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?)\\s*(.*)$/);
            if (tsMatch) {
              timestamp = tsMatch[1];
              message = tsMatch[2];
            } else {
              message = raw;
            }

            const meta = document.createElement('div');
            meta.className = 'log-meta';
            const tsSpan = document.createElement('div');
            tsSpan.textContent = timestamp || '—';
            const typeSpan = document.createElement('div');
            typeSpan.textContent = type || '';
            meta.appendChild(tsSpan);
            meta.appendChild(typeSpan);

            const msg = document.createElement('div');
            msg.className = 'log-message';
            msg.textContent = message;

            body.appendChild(meta);
            body.appendChild(msg);

            row.appendChild(body);
            c.appendChild(row);
          }

          c.scrollTop = c.scrollHeight;
          updateAnalyzeVisibility();
        }

        function appendPlainText(text) {
          const c = document.getElementById('logsContainer');
          const empty = document.getElementById('logsEmpty');
          if (empty) empty.remove();

          const lines = ('' + text).split(/\\r?\\n/);
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (ln === '') continue;
            const div = document.createElement('div');
            const lower = ln.toLowerCase();
            div.className = 'log-row';
            if (lower.indexOf('error') !== -1 || lower.indexOf('exception') !== -1 || lower.indexOf('caused by') !== -1) {
              div.innerHTML = '<div class="log-badge badge-ERROR">ERROR</div><div class="log-body"><div class="log-meta"><div>—</div><div></div></div><div class="log-message">' + escapeHtml(ln) + '</div></div>';
            } else if (lower.indexOf('warn') !== -1 || lower.indexOf('warning') !== -1) {
              div.innerHTML = '<div class="log-badge badge-WARN">WARN</div><div class="log-body"><div class="log-meta"><div>—</div><div></div></div><div class="log-message">' + escapeHtml(ln) + '</div></div>';
            } else {
              div.innerHTML = '<div class="log-badge badge-INFO">INFO</div><div class="log-body"><div class="log-meta"><div>—</div><div></div></div><div class="log-message">' + escapeHtml(ln) + '</div></div>';
            }
            c.appendChild(div);
          }
          c.scrollTop = c.scrollHeight;
          updateAnalyzeVisibility();
        }

        function renderStructured(entries) {
          renderObjects(entries.map(s => ({ raw: s, severity: 'INFO', type: 'stack' })));
        }

        function renderJson(obj) {
          const c = document.getElementById('logsContainer');
          const empty = document.getElementById('logsEmpty');
          if (empty) empty.remove();

          const pre = document.createElement('div');
          pre.className = 'log-row';
          const badge = '<div class="log-badge badge-DEBUG">DEBUG</div>';
          const body = document.createElement('div');
          body.className = 'log-body';
          const msg = document.createElement('div');
          msg.className = 'log-message';
          try {
            msg.textContent = JSON.stringify(obj, null, 2);
          } catch (e) {
            msg.textContent = '' + obj;
          }
          const meta = document.createElement('div');
          meta.className = 'log-meta';
          meta.innerHTML = '<div>—</div><div>json</div>';
          body.appendChild(meta);
          body.appendChild(msg);
          pre.innerHTML = badge;
          pre.appendChild(body);
          c.appendChild(pre);
          c.scrollTop = c.scrollHeight;
          updateAnalyzeVisibility();
        }

        function renderAnalysisResult(result) {
          const a = document.getElementById('analysisContainer');
          if (!a) return;
          a.innerHTML = '';

          const recs = (result && Array.isArray(result.recommendations)) ? result.recommendations : [];
          if (recs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted';
            empty.textContent = '(no recommendations returned)';
            a.appendChild(empty);
          } else {
            const grid = document.createElement('div');
            grid.className = 'analysis-grid';
            recs.forEach((r, i) => {
              const card = document.createElement('div');
              card.className = 'analysis-card';
              card.dataset.recIndex = i;

              const title = document.createElement('div');
              title.className = 'analysis-title';
              title.textContent = r.title || 'Recommendation';

              const desc = document.createElement('div');
              desc.className = 'analysis-desc';
              desc.textContent = r.description || '';

              const actions = document.createElement('div');
              actions.style.display = 'flex';
              actions.style.gap = '8px';
              actions.style.alignItems = 'center';

              const sevBadge = document.createElement('div');
              const sev = (r.severity || 'LOW').toUpperCase();
              sevBadge.className = 'severity-badge severity-' + sev;
              sevBadge.textContent = sev;

              const applyBtn = document.createElement('button');
              applyBtn.className = 'rec-apply';
              applyBtn.textContent = 'Apply';
              applyBtn.onclick = () => {
                applyBtn.disabled = true;
                applyBtn.textContent = 'Applying...';
                vscode.postMessage({ command: 'applyRecommendation', recommendation: r });
              };

              const ignoreBtn = document.createElement('button');
              ignoreBtn.className = 'rec-ignore';
              ignoreBtn.textContent = 'Ignore';
              ignoreBtn.onclick = () => {
                card.remove();
              };

              actions.appendChild(sevBadge);
              actions.appendChild(applyBtn);
              actions.appendChild(ignoreBtn);

              card.appendChild(title);
              card.appendChild(desc);
              card.appendChild(actions);
              grid.appendChild(card);
            });
            a.appendChild(grid);
          }

          const btn = document.getElementById('analyzeBtn');
          if (btn) { btn.disabled = false; btn.textContent = 'Analyze'; }
          setAnalyzeStatus('Analysis complete');
        }

        function renderApplyResult(response) {
          const a = document.getElementById('analysisContainer');
          if (!a) return;

          const card = document.createElement('div');
          card.className = 'apply-result';

          const icon = document.createElement('div');
          icon.className = 'apply-icon';
          icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 12.5L11.5 15L15 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12C21 17.5228 16.5228 22 11 22C5.47715 22 1 17.5228 1 12C1 6.47715 5.47715 2 11 2C16.5228 2 21 6.47715 21 12Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

          const body = document.createElement('div');
          body.style.flex = '1';

          const title = document.createElement('div');
          title.className = 'apply-title';
          title.textContent = response && response.status && response.status.toLowerCase() === 'success' ? 'Applied Successfully' : 'Apply Result';

          const message = document.createElement('div');
          message.className = 'apply-message';
          message.textContent = response && response.message ? response.message : JSON.stringify(response);

          const meta = document.createElement('div');
          meta.className = 'apply-meta';

          const badge = document.createElement('div');
          badge.className = 'apply-badge';
          badge.textContent = response && response.status ? response.status.toUpperCase() : 'UNKNOWN';

          const ts = document.createElement('div');
          ts.className = 'small-muted';
          ts.textContent = new Date().toLocaleString();

          meta.appendChild(badge);
          meta.appendChild(ts);

          const actions = document.createElement('div');
          actions.className = 'apply-actions';

          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn-copy';
          copyBtn.textContent = 'Copy JSON';
          copyBtn.onclick = function() {
            const payload = JSON.stringify(response, null, 2);
            navigator.clipboard && navigator.clipboard.writeText(payload).then(function(){
              copyBtn.textContent = 'Copied';
              setTimeout(function(){ copyBtn.textContent = 'Copy JSON'; }, 1200);
            }).catch(function(){});
          };

          const closeBtn = document.createElement('button');
          closeBtn.className = 'btn-close';
          closeBtn.textContent = 'Dismiss';
          closeBtn.onclick = function() {
            card.remove();
          };

          actions.appendChild(copyBtn);
          actions.appendChild(closeBtn);

          body.appendChild(title);
          body.appendChild(message);
          body.appendChild(meta);
          body.appendChild(actions);

          card.appendChild(icon);
          card.appendChild(body);

          a.insertBefore(card, a.firstChild);
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function handleApplySuccess(recommendation, response) {
          renderApplyResult(response);
          const applyBtns = document.querySelectorAll('.rec-apply');
          applyBtns.forEach(b => { b.disabled = false; b.textContent = 'Apply'; });
        }

        function handleApplyError(recommendation, errorText) {
          const a = document.getElementById('analysisContainer');
          if (!a) return;
          const errCard = document.createElement('div');
          errCard.className = 'analysis-card';
          const title = document.createElement('div');
          title.className = 'analysis-title';
          title.textContent = 'Apply Error';
          const content = document.createElement('div');
          content.className = 'muted';
          content.textContent = '' + errorText;
          errCard.appendChild(title);
          errCard.appendChild(content);
          a.insertBefore(errCard, a.firstChild);
          const applyBtns = document.querySelectorAll('.rec-apply');
          applyBtns.forEach(b => { b.disabled = false; b.textContent = 'Apply'; });
          setAnalyzeStatus('Apply failed');
        }

        function escapeHtml(s) {
          return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\t/g, '    ');
        }

        window.addEventListener('message', function(event) {
          var msg = event.data;
          if (!msg) return;
          if (msg.type === 'logsObjects') {
            renderObjects(msg.entries || []);
          } else if (msg.type === 'logsAppend') {
            appendPlainText(msg.chunk || '');
          } else if (msg.type === 'logsStructured') {
            renderStructured(msg.entries || []);
          } else if (msg.type === 'logsJson') {
            renderJson(msg.json);
          } else if (msg.type === 'clearLogs') {
            const c = document.getElementById('logsContainer');
            c.innerHTML = '<div id="logsEmpty" class="muted">(no logs yet)</div>';
            updateAnalyzeVisibility();
          } else if (msg.type === 'analysisResult') {
            renderAnalysisResult(msg.result);
          } else if (msg.type === 'analysisError') {
            const a = document.getElementById('analysisContainer');
            if (a) a.innerHTML = '<div class="analysis-card"><div class="analysis-title">Analysis Error</div><div class="muted">' + (msg.error || 'Unknown error') + '</div></div>';
          } else if (msg.type === 'analysisClear') {
            const a = document.getElementById('analysisContainer');
            if (a) a.innerHTML = '<div id="analysisEmpty" class="muted">(analysis results will appear here)</div>';
          } else if (msg.type === 'applyResult') {
            handleApplySuccess(msg.recommendation || {}, msg.response);
          } else if (msg.type === 'applyError') {
            handleApplyError(msg.recommendation || {}, msg.error || 'Unknown error');
          } else if (msg.type === 'polledToWebview') {
            const entries = msg.entries || [];
            if (Array.isArray(entries) && entries.length > 0) {
              const c = document.getElementById('logsContainer');
              c.innerHTML = ''; // replace UI with latest polled logs
              renderObjects(entries);
            }
          }
        });

        // initial validation
        validateConfigInputs();
        setTimeout(updateAnalyzeVisibility, 200);
      </script>
    </body></html>
    `;
  }

  // Called when the webview is created / resolved
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

          case 'fetchLogs': {
            const app = message.app || '';
            const log = message.log || '';
            const lines = message.lines || '50';

            if (!app) {
              vscode.window.showErrorMessage('App name is required to fetch logs.');
              return;
            }
            if (!log) {
              vscode.window.showErrorMessage('Log type is required to fetch logs.');
              return;
            }

            try {
              this._lastSentConfig = { app, log, lines };

              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'clearLogs' });
                this.webviewView.webview.postMessage({ type: 'analysisClear' });
              }

              await this._fetchLogsViaQuery(app, log, lines);
              vscode.window.showInformationMessage('Fetch logs request completed.');
            } catch (e) {
              console.error('Failed to fetch logs:', e);
              vscode.window.showErrorMessage('Failed to fetch logs: ' + (e && e.message ? e.message : String(e)));
            }
            break;
          }

          case 'startPolling': {
            const app = message.app || '';
            const log = message.log || '';
            const lines = message.lines || '50';
            const clearPrevious = !!message.clearPrevious;

            if (!app || !log) {
              vscode.window.showErrorMessage('App and log are required to start polling.');
              return;
            }

            // If requested, clear previously fetched logs in extension and instruct webview to clear UI
            if (clearPrevious) {
              this._lastFetchedLogs = [];
              if (this.webviewView) {
                this.webviewView.webview.postMessage({ type: 'clearLogs' });
              }
            }

            // start extension-side polling
            this._startExtensionPolling(app, log, lines);
            break;
          }

          case 'stopPolling': {
            this._stopExtensionPolling();
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

  // Helper to refresh UI externally if needed
  showConfigUI() {
    if (this.webviewView) {
      this._initSecretsPromise.then(async () => {
        this.webviewView.webview.html = await this.getHtml();
      });
    }
  }

  dispose() {
    this._stopExtensionPolling();
    this.webviewView = null;
    this._lastSentConfig = null;
    this._lastFetchedLogs = [];
  }
}

module.exports = { activate, deactivate };
