(() => {
	const el = (id) => document.getElementById(id);
	const localVideo = el('localVideo');
	const remoteVideo = el('remoteVideo');
	const overlay = el('overlay');
	const statusEl = el('status');
	const modeEl = el('mode');
	const btnStart = el('btnStart');
	const roomIdInput = el('roomId');
	const roleSelect = el('role');
	const btnQR = el('btnQR');
	const qrContainer = el('qrContainer');
	const qrUrlEl = el('qrUrl');
	const qrModal = el('qrModal');
	const btnCloseQR = el('btnCloseQR');

	modeEl.textContent = `Mode: ${window.APP_MODE}`;

	function setStatus(text) { statusEl.textContent = text; }
	WebRTCClient.state.onStatus = setStatus;
	WebRTCClient.state.onRemoteStream = (stream) => {
		remoteVideo.srcObject = stream;
		setupOverlaySizing(remoteVideo, overlay);
		startDetectionLoop(stream);
	};

	function setupOverlaySizing(videoEl, canvasEl) {
		const resize = () => {
			const rect = videoEl.getBoundingClientRect();
			canvasEl.width = rect.width;
			canvasEl.height = rect.height;
		};
		resize();
		window.addEventListener('resize', resize);
	}

	btnStart.addEventListener('click', async () => {
		const roomId = roomIdInput.value || 'room123';
		const role = roleSelect.value;
		await WebRTCClient.waitForOpen();
		WebRTCClient.join(roomId, role);
		if (role === 'publisher') {
			await WebRTCClient.startPublisher();
			localVideo.srcObject = WebRTCClient.state.localStream;
			setupOverlaySizing(localVideo, overlay);
		} else {
			await WebRTCClient.startViewer();
		}
	});

	function loadScript(url) {
		return new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.src = url;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('Failed to load ' + url));
			document.head.appendChild(s);
		});
	}

	async function ensureQrLib() {
		try {
			if (window.QRCode) return 'qrcodejs';
			await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
			if (window.QRCode) return 'qrcodejs';
		} catch {}
		try {
			if (window.QRious) return 'qrious';
			await loadScript('https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js');
			if (window.QRious) return 'qrious';
		} catch {}
		throw new Error('QR library failed to load');
	}

	function openQrModal() { qrModal.hidden = false; }
	function closeQrModal() { qrModal.hidden = true; }
	btnCloseQR.addEventListener('click', closeQrModal);
	qrModal.addEventListener('click', (e) => { if (e.target === qrModal) closeQrModal(); });

	function pickBaseUrl() {
		const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
		if (!isLocal) return location.origin;
		return window.SERVER_LAN_URL || location.origin;
	}

	// QR generation for Publisher (in modal)
	btnQR.addEventListener('click', async () => {
		try {
			const which = await ensureQrLib();
			const roomId = roomIdInput.value || 'room123';
			const base = pickBaseUrl();
			const url = `${base}/?room=${encodeURIComponent(roomId)}&role=publisher`;
			qrUrlEl.textContent = url;
			qrContainer.innerHTML = '';
			if (which === 'qrcodejs' && window.QRCode) {
				new QRCode(qrContainer, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
			} else if (window.QRious) {
				const canvas = document.createElement('canvas');
				qrContainer.appendChild(canvas);
				new window.QRious({ element: canvas, value: url, size: 220, level: 'M' });
			}
			openQrModal();
		} catch (err) {
			setStatus('QR error: ' + (err && err.message ? err.message : 'unknown'));
		}
	});

	// Auto-join if query params present
	const params = new URLSearchParams(location.search);
	const qpRoom = params.get('room');
	const qpRole = params.get('role');
	if (qpRoom && qpRole) {
		roomIdInput.value = qpRoom;
		roleSelect.value = qpRole;
		btnStart.click();
	}

	// Detection
	// ==== CONFIG ====
const TARGET_W = 320;
const TARGET_H = 240;
const TARGET_INTERVAL_MS = 70; // ~14 FPS

// ==== STATE ====
let model = null;
let tfReady = false;
let processing = false;
let pending = false;
let lastPreds = [];
let lastMeta = { frame_id: null, capture_ts: null };
let nextFrameId = 1;
let wsDetect = null;

// Lightweight fire-and-forget metrics sender
function sendMetrics(payload) {
	try {
		fetch('/metrics/ingest', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			keepalive: true,
		}).catch(() => {});
	} catch {}
}

// ==== MODEL LOADER (WASM only) ====
async function ensureWasmModelLoaded() {
  if (window.APP_MODE !== 'wasm') return;
  if (model) return;

  // Wait for tf + cocoSsd globals
  await new Promise((resolve) => {
    const check = () =>
      window.tf && window.cocoSsd ? resolve() : setTimeout(check, 50);
    check();
  });

  await tf.setBackend('wasm');
  await tf.ready();

  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  tfReady = true;
  console.log("[WASM] Model loaded");
}

// ==== DRAW OVERLAY ====
function drawOverlayNormalized(predictions, ctx, dw, dh) {
  ctx.clearRect(0, 0, dw, dh);
  ctx.strokeStyle = '#00FF00';
  ctx.fillStyle = 'rgba(0,255,0,0.15)';
  ctx.lineWidth = 2;
  ctx.font = '14px sans-serif';

  predictions.forEach((p) => {
    const x = p.xmin * dw;
    const y = p.ymin * dh;
    const w = (p.xmax - p.xmin) * dw;
    const h = (p.ymax - p.ymin) * dh;

    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#00FF00';
    ctx.fillText(`${p.label} ${(p.score * 100).toFixed(0)}%`, x + 4, y + 16);
    ctx.fillStyle = 'rgba(0,255,0,0.15)';
  });
}

// ==== MAIN LOOP ====
function startDetectionLoop() {
  const videoEl = remoteVideo.srcObject ? remoteVideo : localVideo;
  const offscreen = document.createElement('canvas');
  offscreen.width = TARGET_W;
  offscreen.height = TARGET_H;
  const offctx = offscreen.getContext('2d', { willReadFrequently: true });
  const overlayCtx = overlay.getContext('2d');

  // ---- SERVER MODE: Setup WebSocket ----
  if (window.APP_MODE === 'server') {
    wsDetect = new WebSocket(
      (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
    );

    wsDetect.addEventListener('open', () => {
      console.log("[Server] WS connected for detection");
    });

    wsDetect.addEventListener('error', (e) => {
      setStatus('Detect WS error');
      console.error('[Server] WS error for detection', e);
    });

    wsDetect.addEventListener('close', () => {
      setStatus('Detect WS closed');
      console.warn('[Server] WS closed for detection');
    });

    wsDetect.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'detectResult' && msg.frame_id === lastMeta.frame_id) {
        lastPreds = msg.detections || [];
        const e2e =
          typeof msg.capture_ts === 'number'
            ? Date.now() - msg.capture_ts
            : undefined;
        if (e2e !== undefined)
          setStatus(`E2E: ${e2e} ms (${lastPreds.length} dets)`);
        if (msg.error) {
          setStatus('Server detect error: ' + msg.error);
        }
      }
    });
  }

  // ---- PROCESS EACH FRAME ----
  async function processLatestFrame() {
    if (processing) {
      pending = true;
      return;
    }
    processing = true;
    pending = false;

    try {
      offctx.drawImage(videoEl, 0, 0, TARGET_W, TARGET_H);
      const frame_id = nextFrameId++;
      const capture_ts = Date.now();
      lastMeta = { frame_id, capture_ts };

      if (window.APP_MODE === 'wasm') {
        await ensureWasmModelLoaded();
        const preds = await model.detect(offscreen);

        // Normalize for overlay
        lastPreds = preds.map((p) => ({
          label: p.class,
          score: p.score,
          xmin: p.bbox[0] / TARGET_W,
          ymin: p.bbox[1] / TARGET_H,
          xmax: (p.bbox[0] + p.bbox[2]) / TARGET_W,
          ymax: (p.bbox[1] + p.bbox[3]) / TARGET_H,
        }));

        // send metrics (latency from capture->now, detections count)
        const inference_ts = Date.now();
        const latency_ms = inference_ts - capture_ts;
        sendMetrics({ frame_id, capture_ts, latency_ms, detections: lastPreds.length });
      } else if (window.APP_MODE === 'server') {
        const dataUrl = offscreen.toDataURL('image/jpeg', 0.6);
        if (wsDetect && wsDetect.readyState === WebSocket.OPEN) {
          wsDetect.send(
            JSON.stringify({
              type: 'detect',
              image: dataUrl,
              requestId: frame_id,
              frame_id,
              capture_ts,
            })
          );
        }
      }
    } catch (err) {
      console.error("Detection error:", err);
    } finally {
      processing = false;
      if (pending) setTimeout(processLatestFrame, 0);
    }
  }

  // ---- RENDER LOOP ----
  function renderLoop() {
    drawOverlayNormalized(lastPreds, overlayCtx, overlay.width, overlay.height);
    requestAnimationFrame(renderLoop);
  }

  setInterval(processLatestFrame, TARGET_INTERVAL_MS);
  requestAnimationFrame(renderLoop);
}

})(); 