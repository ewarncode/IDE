/**
 * ESP32 Web Flasher — flasher.js
 * Uses official Espressif esptool-js (unpkg.com/esptool-js)
 * Real ROM bootloader protocol — actually flashes the ESP32
 */
"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let espPort      = null;   // raw Web Serial port
let espLoader    = null;   // ESPLoader instance from esptool-js
let monReader    = null;   // ReadableStreamDefaultReader for monitor
let monActive    = false;
let fwBuffer     = null;   // ArrayBuffer of firmware
let fwName       = "";
let logLines     = [];

// ── DOM shortcuts ─────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = s  => document.querySelector(s);

// ── Boot: check API + auto-load firmware ──────────────────────────────────────
window.addEventListener("load", async () => {
  if (!navigator.serial) {
    $("browserWarn").classList.add("show");
    log("Web Serial API not available. Use Chrome 89+ or Edge 89+.", "err");
    log("Firefox and Safari are NOT supported.", "warn");
  } else {
    log("ESP32 Web Flasher ready.", "ok");
    log("Attempting to auto-load firmware/firmware.bin …", "dim");
    await autoLoadFirmware();
  }
  updateUI();
});

// ── Auto-load firmware.bin from /firmware/ folder ────────────────────────────
async function autoLoadFirmware() {
  try {
    const resp = await fetch("firmware/firmware.bin");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    fwBuffer = await resp.arrayBuffer();
    fwName   = "firmware.bin";
    setFwStatus(true, fwName, fwBuffer.byteLength);
    log(`Auto-loaded: firmware.bin (${fmt(fwBuffer.byteLength)})`, "ok");
    $("fwAutoNote").textContent = `✓ firmware/firmware.bin loaded — ${fmt(fwBuffer.byteLength)}`;
  } catch (e) {
    log("Auto-load failed: " + e.message, "warn");
    log("Drop your firmware.bin into the firmware/ folder, or use the manual upload button.", "dim");
    setFwStatus(false, "firmware/firmware.bin not found", 0);
  }
  updateUI();
}

// ── Manual file override ──────────────────────────────────────────────────────
function handleManualFile(file) {
  if (!file) return;
  if (!file.name.endsWith(".bin")) { log("Only .bin files accepted.", "warn"); return; }
  const reader = new FileReader();
  reader.onload = e => {
    fwBuffer = e.target.result;
    fwName   = file.name;
    setFwStatus(true, fwName, fwBuffer.byteLength);
    $("fwAutoNote").textContent = `Manual upload: ${file.name} (${fmt(fwBuffer.byteLength)})`;
    log(`Loaded: ${file.name} (${fmt(fwBuffer.byteLength)})`, "ok");
    updateUI();
  };
  reader.readAsArrayBuffer(file);
}

function setFwStatus(ready, name, size) {
  const el = $("fwStatus");
  el.className = "fw-status " + (ready ? "ready" : "empty");
  el.querySelector(".fw-icon").textContent = ready ? "✅" : "📦";
  $("fwName").textContent = name;
  $("fwSize").textContent = size ? fmt(size) : "";
}

// ── Port management ───────────────────────────────────────────────────────────
async function requestPort() {
  if (!navigator.serial) { alert("Web Serial not supported. Use Chrome or Edge."); return; }
  try {
    const port = await navigator.serial.requestPort();
    registerPort(port);
    log("Port added. Select it in the dropdown and click Connect.", "info");
  } catch(e) {
    if (e.name !== "NotFoundError") log("Port error: " + e.message, "err");
  }
}

const _portMap = {};
let   _portIdx = 1;

function registerPort(port) {
  const info  = port.getInfo?.() || {};
  const label = info.usbProductId
    ? `USB VID:0x${(info.usbVendorId||0).toString(16).padStart(4,"0")} PID:0x${info.usbProductId.toString(16).padStart(4,"0")}`
    : `Serial Port ${_portIdx}`;
  const key = String(_portIdx++);
  _portMap[key] = port;
  const sel = $("portSelect");
  sel.add(new Option(label, key));
  sel.value = key;
  $("chipPort") && ($("chipPort").textContent = "Port: "+label);
}

async function handleConnect() {
  if (espPort) { await doDisconnect(); return; }
  const key  = $("portSelect").value;
  const port = _portMap[key];
  if (!port) { log("No port selected. Click '+ Request port' first.", "warn"); return; }
  await doConnect(port);
}

async function doConnect(port) {
  const baud = parseInt($("baudSel").value) || 115200;
  try {
    // Open at initial low baud for sync; esptool-js handles speed bump internally
    await port.open({ baudRate: 115200 });
    espPort = port;
    setBadge("globalBadge", "ok", "Connected");
    $("connectBtn").textContent = "Disconnect";
    $("connectBtn").classList.add("active");
    log(`Port opened at 115200 baud (esptool-js will switch to ${baud} during flash).`, "ok");
    updateUI();
  } catch(e) {
    log("Connect failed: " + e.message, "err");
  }
}

async function doDisconnect() {
  await stopMonitor();
  try { espLoader?.disconnect?.(); } catch(_){}
  espLoader = null;
  try { if(espPort) await espPort.close(); } catch(_){}
  espPort = null;
  setBadge("globalBadge","idle","Not connected");
  $("connectBtn").textContent = "Connect";
  $("connectBtn").classList.remove("active");
  log("Port disconnected.", "dim");
  updateUI();
}

// ── FLASH ─────────────────────────────────────────────────────────────────────
async function doFlash() {
  if (!espPort || !fwBuffer) return;

  const erase   = $("optErase").checked;
  const verify  = $("optVerify").checked;
  const reset   = $("optReset").checked;
  const offset  = parseInt($("offsetSel").value, 16);
  const baudRate= parseInt($("baudSel").value) || 921600;

  $("flashBtn").disabled = true;
  setBadge("globalBadge","busy","Flashing…");
  showProg(true);
  setProgress(0, "Initialising esptool…");

  try {
    await stopMonitor();

    // ── Build the transport/loader esptool-js expects ─────────────────────
    // esptool-js needs a Transport wrapper around the port
    const transport = new Transport(espPort, true /* tracing = false */);

    const loaderOpts = {
      transport,
      baudrate:   baudRate,
      terminal:   makeTerminal(),
      enableTracing: false,
      romBaudrate: 115200,
    };

    log("Connecting to ESP32 ROM bootloader…", "info");
    log("→ Hold BOOT, press EN/RST, then release BOOT if auto-reset fails.", "warn");
    setProgress(8, "Connecting…");

    espLoader = new ESPLoader(loaderOpts);
    const chip = await espLoader.main();

    log(`Chip detected: ${chip}`, "ok");
    setProgress(20, `Detected: ${chip}`);

    // ── Erase ─────────────────────────────────────────────────────────────
    if (erase) {
      log("Erasing flash (this takes ~10 s)…", "warn");
      setProgress(25, "Erasing flash…");
      await espLoader.eraseFlash();
      log("Flash erased.", "ok");
    }

    // ── Build file array esptool-js expects ───────────────────────────────
    const flashData = [{
      data:    arrayBufferToBinaryString(fwBuffer),
      address: offset,
    }];

    log(`Flashing ${fwName} → offset 0x${offset.toString(16).toUpperCase()} at ${baudRate} baud…`, "info");
    setProgress(30, "Writing firmware…");

    const flashOpts = {
      fileArray:      flashData,
      flashSize:      "keep",
      flashFreq:      "keep",
      flashMode:      "keep",
      eraseAll:       false,
      compress:       true,
      reportProgress: (idx, written, total) => {
        const pct = 30 + Math.round((written / total) * 60);
        setProgress(pct, `Writing… ${fmt(written)} / ${fmt(total)}`);
      },
      calculateMD5Hash: str => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(str)).toString(),
    };

    await espLoader.writeFlash(flashOpts);
    log("Firmware written.", "ok");
    setProgress(90, "Finalising…");

    // ── Reset ─────────────────────────────────────────────────────────────
    if (reset) {
      await espLoader.hardReset();
      log("ESP32 reset — your firmware is running!", "ok");
    }

    setProgress(100, "Done!");
    setBadge("globalBadge","done","Flash OK");
    log("─── Flash complete ✓ ───", "ok");

  } catch(e) {
    log("Flash error: " + e.message, "err");
    setBadge("globalBadge","err","Flash failed");
    setProgress(0, "Failed");
  } finally {
    try { await espLoader?.transport?.disconnect?.(); } catch(_){}
    espLoader = null;
    // Re-open port for monitor use
    try {
      if (espPort && !espPort.readable) await espPort.open({ baudRate: parseInt($("baudSel").value)||115200 });
    } catch(_){}
    $("flashBtn").disabled = false;
    updateUI();

    if (espPort && $("optReset").checked) {
      setTimeout(() => { log("Tip: click 'Open Monitor' to see serial output from your sketch.", "dim"); }, 600);
    }
  }
}

// ── esptool-js terminal hook (pipes output to our monitor) ───────────────────
function makeTerminal() {
  return {
    clean()    {},
    writeLine(data) { log(String(data), "dim"); },
    write(data)     { log(String(data).trimEnd(), "dim"); },
  };
}

// ── Serial Monitor ────────────────────────────────────────────────────────────
async function toggleMonitor() {
  monActive ? await stopMonitor() : await startMonitor();
}

async function startMonitor() {
  if (!espPort) { log("Connect a port first.", "warn"); return; }
  if (monActive) return;

  // Make sure port is open at the selected baud (monitor baud = user selected)
  const monBaud = parseInt($("baudSel").value) || 115200;
  try {
    if (!espPort.readable) await espPort.open({ baudRate: monBaud });
  } catch(e) {
    // already open is fine
  }

  monActive = true;
  setBadge("monBadge","ok","Live");
  $("monBtn").textContent = "Close Monitor";
  $("monBtn").classList.add("active");
  log(`Serial monitor open at ${monBaud} baud.`, "ok");

  readLoop();
}

async function readLoop() {
  try {
    monReader = espPort.readable.getReader();
    const dec = new TextDecoder();
    let   buf = "";

    while (monActive) {
      const { value, done } = await monReader.read();
      if (done || !monActive) break;
      buf += dec.decode(value, { stream: true });

      // Flush complete lines
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();            // incomplete tail
      for (const line of parts) {
        log(line, "data");
      }
    }
    if (buf.trim()) log(buf, "data");  // flush remaining
  } catch(e) {
    if (monActive) log("Monitor error: " + e.message, "err");
  } finally {
    try { monReader?.releaseLock(); } catch(_){}
    monReader = null;
  }
}

async function stopMonitor() {
  if (!monActive) return;
  monActive = false;
  try { await monReader?.cancel(); } catch(_){}
  setBadge("monBadge","idle","Closed");
  $("monBtn").textContent = "Open Monitor";
  $("monBtn").classList.remove("active");
  log("Monitor closed.", "dim");
}

async function sendSerial() {
  const inp = $("serInput");
  const txt = inp.value.trim();
  if (!txt) return;
  if (!espPort || !espPort.writable) { log("Not connected.", "warn"); return; }
  try {
    const w = espPort.writable.getWriter();
    await w.write(new TextEncoder().encode(txt + "\r\n"));
    w.releaseLock();
    log(">> " + txt, "dim");
  } catch(e) { log("Send error: " + e.message, "err"); }
  inp.value = "";
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, type="") {
  const body = $("monBody");
  const ts   = new Date().toTimeString().slice(0,8);
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="ts">${ts}</span><span class="msg ${type}">${esc(msg)}</span>`;
  body.appendChild(line);
  logLines.push(`[${ts}] ${msg}`);
  if (logLines.length > 8000) logLines.shift();
  if ($("autoScroll").checked) body.scrollTop = body.scrollHeight;
}

function clearMon() { $("monBody").innerHTML=""; logLines=[]; }
function downloadLog() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([logLines.join("\n")],{type:"text/plain"}));
  a.download = "esp32-log.txt"; a.click();
}

// ── Progress ──────────────────────────────────────────────────────────────────
function showProg(v) { $("progWrap").classList.toggle("show",v); }
function setProgress(pct, label) {
  $("progFill").style.width  = pct + "%";
  $("progLabel").textContent = label;
  $("progPct").textContent   = Math.round(pct) + "%";
}

// ── Badges ────────────────────────────────────────────────────────────────────
function setBadge(id, type, text) {
  const el = $(id);
  el.className = "badge " + type;
  const pulse = (type==="busy"||type==="ok"&&id==="monBadge") ? " pulse":"";
  el.innerHTML = `<span class="dot${pulse}"></span>${text}`;
}

// ── UI enable/disable ─────────────────────────────────────────────────────────
function updateUI() {
  const connected = !!espPort;
  const hasFw     = !!fwBuffer;
  $("flashBtn").disabled = !(connected && hasFw);
}

function updateChips() {}   // no-op; chips shown in selects themselves

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (bytes < 1024)       return bytes + " B";
  if (bytes < 1048576)    return (bytes/1024).toFixed(1) + " KB";
  return (bytes/1048576).toFixed(2) + " MB";
}

function esc(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

function arrayBufferToBinaryString(buf) {
  const bytes = new Uint8Array(buf);
  let   str   = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return str;
}