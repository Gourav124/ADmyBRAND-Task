
## Run (WASM mode (prefered))

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
4. metrics.json file is under server folder.

## Design Choices
1. Uses Web RTC for phone-> browser live streaming.
2. For Model Deployment, running TensorFlow.js(WASM backend) directly in the browser. Which is also helpful for object detection in browser.
3. Uses Canvas API to draw bounding boxes and labes on Video stream.
4. For backend, uses Node.js for server runtime, Express.js to serve static files and signaling endpoints.
5. Socket.IO / WebSocket → peer-to-peer signaling for WebRTC connections.
