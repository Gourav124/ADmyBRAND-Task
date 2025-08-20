
## Run (WASM mode)

```bash (preferred)
npm run start:wasm
```

## Run (Server mode)

```bash
npm run start:server
```

Open `http://localhost:3000` on both devices(use ngrok).

1. On desktop, choose role "Viewer" (default) and a Room ID (e.g., `room123`), click Start.
2. On phone, open same URL or scan QR, choose role "Publisher", same Room ID, click Start. Grant camera permission.
3. You should see the phone camera on desktop, with detection boxes overlaid in near real-time.