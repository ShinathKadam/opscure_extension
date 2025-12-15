# Opscure VS Code Extension

---

## 📌 Description
**Opscure is a VS Code extension that helps developers fetch logs from a specified log file path, analyze them, and identify & fix issues using AI.**
It simplifies debugging by continuously reading logs and providing AI-powered suggestions when issues are detected.

---

## ✅ Features

Fetch logs from a user-specified log file path

Read latest logs from the bottom of the log file

Analyze logs for errors and warnings

AI-based issue detection and fix suggestions

Secure handling of API keys using VS Code Secret Storage

---

## 🔧 Pre-requisites

Before using the Opscure extension, ensure you have:

Visual Studio Code

Node.js

A valid log file path

An AI API key (stored securely)

Application logs written to a file

---

## 🧩 Installation Requirements & Setup
### 1️⃣ Install Visual Studio Code

Download and install VS Code from:

```arduino
https://code.visualstudio.com/
```

### 2️⃣ Install Node.js (Required)

Opscure requires Node.js to build and run the extension.

Download Node.js (LTS version recommended):

```arduino
https://nodejs.org/
```

Verify installation:

```bash
node -v
npm -v
```

### 3️⃣ Install Git

Git is required to clone and manage the extension source code.

Download Git:

```arduino
https://git-scm.com/downloads
```

Verify installation:

```bash
git --version
```

### 4️⃣ Install VS Code Extension Generator (For Development)

Required to create and scaffold VS Code extensions.

```bash
npm install -g yo generator-code
```

Verify:

```bash
yo --version
```

---

## 🚀 How It Runs
### 1️⃣ Configure Log File

Ensure your application writes logs to a file.

If your app runs locally and does not store logs, restart it using:

```bash
your_command_here | Tee-Object -FilePath app.log
```

Replace:

your_command_here → your application start command

app.log → desired log file name

### 2️⃣ Run the Extension Locally

```bash
npm install
npm run compile
```

Press F5 in VS Code to launch the extension in a new Extension Development Host window.

### 3️⃣ Log Analysis Flow

Opscure reads logs continuously

Latest logs are fetched from the bottom of the file

Logs are sent to the AI engine

Detected issues and fixes are displayed inside VS Code

---

## 🔐 Security

API keys and UUIDs are stored using VS Code Secret Storage

No secrets are committed or logged

Secure communication with AI services

---

## 📦 Supported Logs

Backend application logs

Server logs

Service logs

Custom text-based log files

---

## 📄 License

MIT License

---
