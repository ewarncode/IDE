# ESP32 Web Flasher

A browser-based tool to flash `.bin` firmware directly to ESP32 boards using the **Web Serial API** — no drivers, no desktop software needed.

---

## File Structure

```
esp32-flasher/
├── index.html          ← Web flasher UI (open this in Chrome/Edge)
├── flasher.js          ← Flash logic + Serial Monitor
├── README.md           ← This file
└── firmware/           ← PUT YOUR .bin FILES HERE
    └── (your firmware.bin files go here)
```

---

## How to Use

### 1. Build your firmware in VSCode (Arduino / PlatformIO)

**Arduino IDE / VSCode Arduino Extension:**
- Open your `blink.ino` sketch
- Select Board: `ESP32 Dev Module`
- Go to `Sketch → Export Compiled Binary`
- Your `.bin` file will appear in your sketch folder

**PlatformIO:**
- Run: `pio run` (or click the ✓ Build button)
- Find your binary at:
  ```
  .pio/build/esp32dev/firmware.bin
  ```

### 2. Open the Web Flasher

- Open `index.html` in **Google Chrome** or **Microsoft Edge** (version 89+)
- Firefox and Safari are NOT supported (no Web Serial API)

### 3. Configure

| Setting   | Value                                 |
|-----------|---------------------------------------|
| Port      | Click "Request port" → select your COM/ttyUSB port |
| Board     | ESP32 Dev Module (or your variant)   |
| Baud Rate | `921600` for fast flash, `115200` default |

### 4. Upload .bin

- Drag and drop your `.bin` file onto the upload zone
- Set flash offset (default `0x0000` — change to `0x1000` for bootloader-only)
- Click **Flash Firmware**

### 5. Put ESP32 into Bootloader Mode

- Hold the **BOOT** button on your board
- Press **EN/RST**
- Release BOOT
- The flasher will auto-detect and sync

### 6. Monitor Output

- Click **Open Monitor** to see Serial output
- Type commands in the input box and press Enter or SEND

---

## Common Bin File Offsets

| File              | Offset   |
|-------------------|----------|
| bootloader.bin    | 0x1000   |
| partitions.bin    | 0x8000   |
| boot_app0.bin     | 0xE000   |
| firmware.bin      | 0x10000  |
| (full flash)      | 0x0000   |

> For most users, just use `firmware.bin` at `0x0000` which includes everything merged.

---

## Requirements

- Chrome 89+ or Edge 89+
- A web server or just open `index.html` directly (file:// works for Chrome with `--allow-file-access-from-files`)
- OR serve locally: `npx serve .`

---

## Serving Locally (Optional)

```bash
# Using Node.js
npx serve .

# Using Python
python -m http.server 8080
```

Then open `http://localhost:8080`