import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import os from 'os';
// removed static import of wrtc to avoid crash when not installed
import jpeg from 'jpeg-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODE = process.env.MODE === 'server' ? 'server' : 'wasm';
const USE_HTTPS = process.env.USE_HTTPS === '1';
const PORT = process.env.PORT || 4000;

const app = express();

// Lightweight rolling metrics (latency + fps) with periodic write to metrics.json
// const fs = require('fs');
// const path = require('path');

const METRICS_FILE = path.join(__dirname,'metrics.json');
const MAX_SAMPLES = 500;
const FPS_WINDOW_MS = 5000;

const metricsState = {
	latencySamplesMs: [],
	detectionTimestamps: []
};
function recordLastDetection(info) {
	metricsState.lastDetection = info;
  }
function recordLatencySample(latencyMs) {
	if (typeof latencyMs !== 'number' || !isFinite(latencyMs) || latencyMs < 0) return;
	metricsState.latencySamplesMs.push(latencyMs);
	if (metricsState.latencySamplesMs.length > MAX_SAMPLES) {
		metricsState.latencySamplesMs.splice(0, metricsState.latencySamplesMs.length - MAX_SAMPLES);
	}
}

function recordDetectionTimestamp(tsMs) {
	metricsState.detectionTimestamps.push(tsMs);
	const cutoff = tsMs - FPS_WINDOW_MS;
	while (metricsState.detectionTimestamps.length && metricsState.detectionTimestamps[0] < cutoff) {
		metricsState.detectionTimestamps.shift();
	}
}

function percentile(sortedArr, p) {
	if (!sortedArr.length) return 0;
	const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))));
	return sortedArr[idx];
}

function computeAndWriteMetrics() {
	try {
		const latencies = metricsState.latencySamplesMs.slice().sort((a, b) => a - b);
		const median = percentile(latencies, 0.5);
		const p95 = percentile(latencies, 0.95);

		const now = Date.now();
		const cutoff = now - FPS_WINDOW_MS;
		const inWindow = metricsState.detectionTimestamps.filter((t) => t >= cutoff).length;
		const fps = inWindow / (FPS_WINDOW_MS / 1000);

		const payload = {
			median_latency_ms: Math.round(median),
			p95_latency_ms: Math.round(p95),
			fps,
			samples_count: latencies.length,
			last_detection: metricsState.lastDetection || null
		};

		fs.writeFile(METRICS_FILE, JSON.stringify(payload, null, 2), (err) => {
			if (err) console.warn('[metrics] write error:', err.message);
		});
	} catch (e) {
		console.warn('[metrics] compute/write error:', e && e.message ? e.message : e);
	}
}

setInterval(computeAndWriteMetrics, 5000);  
computeAndWriteMetrics();


console.log('[metrics] enabled; writing to', METRICS_FILE);

// Parse JSON bodies for metrics ingest
app.use(express.json({ limit: '1mb' }));

// Expose a lightweight ingestion endpoint for client-side (WASM) detections
app.post('/metrics/ingest', (req, res) => {
	try {
		const { latency_ms, detections, frame_id, capture_ts } = req.body || {};
		const inference_ts = Date.now();
		if (typeof detections === 'number') {
			recordDetectionTimestamp(inference_ts);
		}
		if (typeof latency_ms === 'number') {
			recordLatencySample(latency_ms);
		}
		recordLastDetection({
			frame_id,
			latency_ms: typeof latency_ms === 'number' ? latency_ms : undefined,
			detections: typeof detections === 'number' ? detections : undefined,
			mode: 'wasm',
			capture_ts,
			inference_ts
		});
		computeAndWriteMetrics();
		return res.status(200).json({ ok: true });
	} catch (e) {
		return res.status(400).json({ ok: false, error: e && e.message ? e.message : 'bad request' });
	}
});


// Dynamically load wrtc when needed
let wrtcModule = null;
async function getWrtc() {
	if (wrtcModule) return wrtcModule;
	try {
		const mod = await import('wrtc');
		wrtcModule = mod.default || mod;
		return wrtcModule;
	} catch (e) {
		console.warn('[server-viewer] wrtc not available:', e.message);
		return null;
	}
}

function isPrivateIPv4(ip) {
	if (!ip) return false;
	if (ip.startsWith('10.')) return true;
	if (ip.startsWith('192.168.')) return true;
	const m = ip.match(/^172\.(\d+)\./);
	if (m) { const n = Number(m[1]); if (n >= 16 && n <= 31) return true; }
	return false;
}

function getLanIPv4() {
	const nets = os.networkInterfaces();
	let fallback = null;
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] || []) {
			if (net.family === 'IPv4' && !net.internal) {
				if (isPrivateIPv4(net.address)) return net.address;
				if (!fallback) fallback = net.address;
			}
		}
	}
	return fallback || 'localhost';
}

// Create HTTP or HTTPS server
let server;
if (USE_HTTPS) {
	try {
		const keyPath = process.env.SSL_KEY_FILE || path.join(__dirname, 'certs', 'localhost.key');
		const certPath = process.env.SSL_CERT_FILE || path.join(__dirname, 'certs', 'localhost.crt');
		const key = fs.readFileSync(keyPath);
		const cert = fs.readFileSync(certPath);
		server = https.createServer({ key, cert }, app);
		console.log('[server] HTTPS enabled');
	} catch (e) {
		console.warn('[server] USE_HTTPS=1 but failed to load certs, falling back to HTTP:', e.message);
		server = http.createServer(app);
	}
} else {
	server = http.createServer(app);
}

const SCHEME = USE_HTTPS ? 'https' : 'http';
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').trim();
const PUBLIC_PORT = process.env.PUBLIC_PORT || PORT;
const SERVER_LAN_URL = `${SCHEME}://${PUBLIC_HOST || getLanIPv4()}:${PUBLIC_PORT}`;

// Static files
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Health
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Dynamic config for client
app.get('/config.js', (_req, res) => {
	res.setHeader('Content-Type', 'application/javascript');
	res.setHeader('Cache-Control', 'no-store, max-age=0');
	res.send(`window.APP_MODE = '${MODE}'; window.SERVER_LAN_URL = '${SERVER_LAN_URL}';`);
	console.log('[config.js] served with APP_MODE=', MODE, 'SERVER_LAN_URL=', SERVER_LAN_URL);
});

// Expose current metrics for quick verification
app.get('/metrics', (_req, res) => {
	try {
		const data = fs.readFileSync(METRICS_FILE, 'utf8');
		res.setHeader('Content-Type', 'application/json');
		res.send(data);
	} catch (e) {
		res.status(200).json({ error: 'metrics file not found', path: METRICS_FILE });
	}
});


// Simple in-memory signaling rooms (one publisher, one viewer)
const rooms = new Map(); // roomId -> { publisher: ws|null, viewer: ws|null }

function getOrCreateRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, { publisher: null, viewer: null });
	}
	return rooms.get(roomId);
}

function cleanupSocket(ws) {
	if (ws.roomId && ws.role) {
		const room = rooms.get(ws.roomId);
		if (room && room[ws.role] === ws) {
			room[ws.role] = null;
		}
	}
}

const wss = new WebSocketServer({ server });

// Lazy-loaded detector for server mode
let detector = null;
let loadingDetectorPromise = null;

async function loadDetector() {
	if (detector) return detector;
	if (loadingDetectorPromise) return loadingDetectorPromise;
	loadingDetectorPromise = (async () => {
		let tf;
		const preferTfjsNode = process.env.NO_TFJS_NODE !== '1' && process.env.USE_TFJS_NODE !== '0';
		if (preferTfjsNode) {
			try {
				// Preferred: native bindings for performance
				const tfNode = await import('@tensorflow/tfjs-node');
				tf = tfNode;
				console.log('[detect] using tfjs-node backend');
			} catch (e) {
				console.warn('[detect] tfjs-node not available, falling back to @tensorflow/tfjs (CPU):', e && e.message ? e.message : e);
			}
		}
		if (!tf) {
			const tfJs = await import('@tensorflow/tfjs');
			tf = tfJs;
			if (tf.setBackend) {
				await tf.setBackend('cpu');
			}
			if (tf.ready) {
				await tf.ready();
			}
		}
		const cocoSsd = await import('@tensorflow-models/coco-ssd');
		const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
		return { tf, model };
	})();
	detector = await loadingDetectorPromise;
	return detector;
}

function decodeJpegToTensor(tf, buffer) {
  try {
    const raw = jpeg.decode(buffer, { useTArray: true });
    const { data, width, height } = raw;
    // jpeg-js outputs RGBA; strip alpha channel
    const numPixels = width * height;
    const rgb = new Uint8Array(numPixels * 3);
    for (let i = 0, j = 0; i < numPixels; i += 1, j += 4) {
      rgb[i * 3] = data[j];
      rgb[i * 3 + 1] = data[j + 1];
      rgb[i * 3 + 2] = data[j + 2];
    }
    const tensor = tf.tensor3d(rgb, [height, width, 3], 'int32');
    return { tensor, width, height };
  } catch (e) {
    throw new Error('jpeg decode failed: ' + (e && e.message ? e.message : e));
  }
}

// Optional: server joins a room as a headless viewer to receive media
const serverViewers = new Map(); // roomId -> { pc, started, rtc }

app.get('/server-viewer/start', async (req, res) => {
	const roomId = (req.query.roomId || '').toString();
	if (!roomId) return res.status(400).send('roomId required');
	if (serverViewers.has(roomId)) return res.status(200).send('already started');
	const rtc = await getWrtc();
	if (!rtc) return res.status(501).send('wrtc not installed');
	const pc = new rtc.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
	pc.ontrack = (e) => {
		const stream = e.streams[0];
		console.log(`[server-viewer] track received for room ${roomId}`, stream && stream.id);
	};
	pc.onicecandidate = (e) => {
		if (e.candidate) {
			const room = rooms.get(roomId);
			if (room && room.publisher) {
				room.publisher.send(JSON.stringify({ type: 'signal', from: 'viewer', data: { candidate: e.candidate } }));
			}
		}
	};
	serverViewers.set(roomId, { pc, started: true, rtc });
	const offer = await pc.createOffer({ offerToReceiveVideo: true });
	await pc.setLocalDescription(offer);
	const room = getOrCreateRoom(roomId);
	if (room.publisher) {
		room.publisher.send(JSON.stringify({ type: 'signal', from: 'viewer', data: { sdp: pc.localDescription } }));
	}
	return res.status(200).send('started');
});

wss.on('connection', (ws) => {
	ws.on('message', async (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch (e) {
			return;
		}

		// { type: 'join', roomId, role: 'publisher'|'viewer' }
		if (msg.type === 'join') {
			ws.roomId = msg.roomId;
			ws.role = msg.role;
			const room = getOrCreateRoom(ws.roomId);
			if (msg.role === 'publisher') room.publisher = ws;
			if (msg.role === 'viewer') room.viewer = ws;
			return;
		}

		// Signaling relay: { type: 'signal', to: 'publisher'|'viewer', data }
		if (msg.type === 'signal') {
			const room = rooms.get(ws.roomId);
			if (!room) return;
			const target = msg.to === 'publisher' ? room.publisher : room.viewer;
			if (target && target.readyState === target.OPEN) {
				target.send(JSON.stringify({ type: 'signal', from: ws.role, data: msg.data }));
			}
			// If signaling comes from publisher to viewer and server viewer exists, feed into wrtc pc
			if (ws.role === 'publisher') {
				const sv = serverViewers.get(ws.roomId);
				if (sv) {
					const { pc, rtc } = sv;
					if (msg.data.sdp && rtc) {
						await pc.setRemoteDescription(new rtc.RTCSessionDescription(msg.data.sdp));
						if (msg.data.sdp.type === 'offer') {
							const answer = await pc.createAnswer();
							await pc.setLocalDescription(answer);
							if (room.publisher) {
								room.publisher.send(JSON.stringify({ type: 'signal', from: 'viewer', data: { sdp: pc.localDescription } }));
							}
						}
					}
					if (msg.data.candidate && rtc) {
						try { await pc.addIceCandidate(new rtc.RTCIceCandidate(msg.data.candidate)); } catch { }
					}
				}
			}
			return;
		}

		// Server-side detection RPC (unchanged except for schema)
		if (msg.type === 'detect') {
			const recv_ts = Date.now();
			try {
				const { tf, model } = await loadDetector();

				let detections = [];
				let h, w;

				if (MODE === 'server') {
					// -------- SERVER MODE (Node.js + tfjs-node) --------
					const base64 = (msg.image || '').split(',')[1];
					if (!base64) throw new Error('invalid image');
					const buffer = Buffer.from(base64, 'base64');
					let tensor;
					if (typeof (detector && detector.tf && detector.tf.node && detector.tf.node.decodeImage) === 'function') {
						tensor = detector.tf.node.decodeImage(buffer, 3);
					} else {
						const decoded = decodeJpegToTensor(detector.tf, buffer);
						tensor = decoded.tensor;
					}
					[h, w] = tensor.shape.slice(0, 2);

					const predictions = await model.detect(tensor);
					tensor.dispose();

					detections = (predictions || []).map((p) => {
						const [x, y, bw, bh] = p.bbox;
						return {
							label: p.class,
							score: p.score,
							xmin: Math.max(0, Math.min(1, x / w)),
							ymin: Math.max(0, Math.min(1, y / h)),
							xmax: Math.max(0, Math.min(1, (x + bw) / w)),
							ymax: Math.max(0, Math.min(1, (y + bh) / h)),
						};
					});
				} else if (MODE === 'wasm') {
					// -------- WASM MODE (Browser + tfjs-backend-wasm) --------
					const imgElement = document.getElementById('video'); // or canvas
					const tensor = tf.browser.fromPixels(imgElement);
					[h, w] = tensor.shape.slice(0, 2);

					const predictions = await model.detect(tensor);
					tensor.dispose();

					detections = (predictions || []).map((p) => {
						const [x, y, bw, bh] = p.bbox;
						return {
							label: p.class,
							score: p.score,
							xmin: Math.max(0, Math.min(1, x / w)),
							ymin: Math.max(0, Math.min(1, y / h)),
							xmax: Math.max(0, Math.min(1, (x + bw) / w)),
							ymax: Math.max(0, Math.min(1, (y + bh) / h)),
						};
					});
				}

				const inference_ts = Date.now();
				const response = {
					type: 'detectResult',
					frame_id: msg.frame_id,
					capture_ts: msg.capture_ts,
					recv_ts,
					inference_ts,
					detections,
					requestId: msg.requestId,
				};
				ws.send(JSON.stringify(response));

				const latency = typeof msg.capture_ts === 'number'
					? (inference_ts - msg.capture_ts)
					: undefined;
				console.log(JSON.stringify({
					event: 'detect',
					mode: MODE,
					frame_id: msg.frame_id,
					latency_ms: latency,
					detections: detections.length,
				}));

				recordDetectionTimestamp(inference_ts);
				if (typeof latency === 'number') {
					recordLatencySample(latency);
				}

				// NEW: save this detection into metrics
				recordLastDetection({
					frame_id: msg.frame_id,
					latency_ms: latency,
					detections: detections.length,
					mode: MODE,
					inference_ts
				});

				// Write metrics.json immediately for each detection
				computeAndWriteMetrics();


			} catch (err) {
				ws.send(JSON.stringify({
					type: 'detectResult',
					frame_id: msg.frame_id,
					capture_ts: msg.capture_ts,
					recv_ts,
					inference_ts: Date.now(),
					detections: [],
					error: err.message
				}));
			}
			return;
		}
	});

	ws.on('close', () => cleanupSocket(ws));
});

server.listen(PORT, () => {
	console.log(`[server] listening on ${SCHEME}://localhost:${PORT} (MODE=${MODE}) LAN=${SERVER_LAN_URL}`);

	
}); 