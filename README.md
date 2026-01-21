# 📘 Opscure VS Code Extension – Updated README
# OPSCURE VS Code Extension
## 📌 Description

Opscure is an AI-powered VS Code extension that runs a Go-based stream agent as a sidecar, captures live application logs directly from a terminal session, preprocesses them into structured bundles, and sends them to an AI pipeline to detect issues and recommend fixes.

It is designed to provide a **continuous incident → analysis → remediation loop** directly inside VS Code.

Opscure does not rely on manual log uploads. It launches your application, captures stdout/stderr in real time, batches logs, and streams them automatically to the Go agent.

---

## ✅ Key Features

- Run any application inside an OPSCURE-managed terminal

- Live capture of stdout and stderr

- Automatic severity detection (ERROR / WARN / INFO / DEBUG)

- Log batching and streaming to Go sidecar agent

- /stream/ingest integration

- Bundle-based preprocessing

- /logs/preprocess integration

- AI-powered incident and root-cause analysis

- Structured timeline and bundle visualization

- Embedded VS Code webview dashboard

- Automatic Go agent startup

- Secure local-only communication (127.0.0.1)

---

## 🧠 How Opscure Works (High Level)

1. Extension starts → Go agent is launched as a sidecar

2. Agent writes its active port to server/agent.port

3. Extension waits and connects automatically

4. User runs an app using Opscure terminal

5. Logs are captured live

6. Logs are batched and sent to /stream/ingest

7. Agent returns structured bundles

8. Bundles are sent to /logs/preprocess

9. AI analysis results are rendered inside VS Code

---

## 🔧 Pre-Setup Requirements

Before running Opscure, make sure the following are installed:

**1️⃣ Visual Studio Code**

Latest stable recommended
https://code.visualstudio.com/

Verify:

```bash
code --version
```

---

**2️⃣ Node.js (Required for extension runtime)**

LTS version recommended
https://nodejs.org/

Verify:

```bash
node -v
npm -v
```

---

## 3️⃣ Go (Required for the Opscure agent)

Required to build or modify the Go agent.

https://go.dev/dl/

Verify:

```bash
go version
```

---

**4️⃣ Git (Recommended)**

https://git-scm.com/downloads

Verify:

```bash
git --version
```

**5️⃣ Application to Monitor**

Any application you want Opscure to run and observe, for example:

- Spring Boot app

- Node.js service

- Python server

- CLI tool

- Microservice

---

## 📦 Project Setup

Clone the repository:

```bash
git clone <your-repo-url>
cd opscure-extension
```

Install dependencies:

```bash
npm install
```

Compile the extension:

```bash
npm run compile
```

Ensure the Go agent binary exists:

```bash
server/go-agent   (mac/linux)
server/go-agent.exe (windows)
```

And the folder:

```bash
server/go_agent/
```

---

## ▶️ Running the Extension (Developer Mode)
**Step 1 – Open project in VS Code**

```bash
code .
```

---

**Step 2 – Start Extension Host**

Press:

```nginx
F5
```

This launches a new Extension Development Host window with Opscure loaded.

---

**Step 3 – Open Opscure Panel**

Click the OPSCURE icon in the Activity Bar.

You will see:

- Captured Logs panel

- Parsed logs panel

- Preprocess response

- Analyze response

---

**Step 4 – Start Capturing Logs**

Click:

```powershell
Start
```

You will be prompted:

```vbnet
Enter command to run with OPSCURE
```

Example:

```bash
npm start
mvn spring-boot:run
python app.py
java -jar app.jar
```

Opscure will:

- Launch the process

- Create a managed terminal

- Capture all logs automatically

---

**Step 5 – Observe Live Logs**

You will see logs appearing in:

- ✅ Captured Logs

- ✅ Parsed Logs

Once bundles are formed, the Analyze button becomes available.

---

**Step 6 – Trigger AI Analysis**

Click:

```nginx
Analyze
```

Opscure will:

- Combine all stored bundles

- Send them to /logs/preprocess

- Display AI responses in the UI

---

## 🔄 Runtime Flow

```bash
Application → Opscure Terminal → Log Capture
        ↓
Batching (50 logs)
        ↓
/stream/ingest
        ↓
Bundle store
        ↓
/logs/preprocess
        ↓
AI Analysis
        ↓
VS Code UI
```

---

## 🔐 Security

- Go agent runs locally

- Uses dynamic local port binding

- No logs are sent without user execution

- No external exposure

- Agent lifecycle is bound to extension

- Process is killed automatically on extension shutdown

---

## 📂 Supported Inputs

- Backend services

- CLI tools

- Build systems (maven, gradle, npm, go)

- Microservices

- Long-running servers

- Batch jobs

---

## 🛠 Troubleshooting
**Agent not detected**

Ensure:

```bash
server/agent.port
```

is being written by the Go agent.

**No logs appearing**

Make sure the command actually produces stdout/stderr.

**Analyze button not showing**

At least one valid bundle must be received from ```/stream/ingest```.

---

## 📄 License

MIT License (or your internal OPSCURE license)

---
