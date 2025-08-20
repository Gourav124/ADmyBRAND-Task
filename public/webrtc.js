(() => {
	const signalingUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
	const ws = new WebSocket(signalingUrl);

	const state = {
		pc: null,
		role: null,
		roomId: null,
		localStream: null,
		onConnected: null,
		onRemoteStream: null,
		onStatus: null,
	};

	function setStatus(msg) {
		if (state.onStatus) state.onStatus(msg);
	}

	function waitForOpen() {
		return new Promise((resolve) => {
			if (ws.readyState === WebSocket.OPEN) return resolve();
			ws.addEventListener('open', () => resolve(), { once: true });
		});
	}

	function join(roomId, role) {
		state.roomId = roomId;
		state.role = role;
		ws.send(JSON.stringify({ type: 'join', roomId, role }));
	}

	async function ensurePeerConnection() {
		if (state.pc) return state.pc;
		const pc = new RTCPeerConnection({
			iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
		});
		pc.onicecandidate = (e) => {
			if (e.candidate) {
				ws.send(JSON.stringify({ type: 'signal', to: state.role === 'publisher' ? 'viewer' : 'publisher', data: { candidate: e.candidate } }));
			}
		};
		pc.ontrack = (e) => {
			if (state.onRemoteStream) state.onRemoteStream(e.streams[0]);
		};
		state.pc = pc;
		return pc;
	}

	async function startPublisher() {
		const pc = await ensurePeerConnection();
		// Warn if not secure origin
		const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
		if (!isLocalhost && location.protocol !== 'https:') {
			setStatus('Camera may be blocked on HTTP. Use HTTPS or localhost.');
		}
		try {
			const constraints = {
				video: {
					facingMode: { ideal: 'environment' },
					width: { ideal: 1280 },
					height: { ideal: 720 }
				},
				audio: false
			};
			state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
			state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
			setStatus('Publisher ready, waiting for viewer offer');
		} catch (err) {
			setStatus('getUserMedia error: ' + (err && err.name ? err.name : 'unknown') + (location.protocol !== 'https:' && !isLocalhost ? ' (serve over HTTPS)' : ''));
			throw err;
		}
	}

	async function startViewer() {
		const pc = await ensurePeerConnection();
		const offer = await pc.createOffer({ offerToReceiveVideo: true });
		await pc.setLocalDescription(offer);
		ws.send(JSON.stringify({ type: 'signal', to: 'publisher', data: { sdp: pc.localDescription } }));
		setStatus('Viewer offer sent');
	}

	ws.addEventListener('message', async (evt) => {
		const msg = JSON.parse(evt.data);
		if (msg.type !== 'signal') return;
		const pc = await ensurePeerConnection();
		if (msg.data.sdp) {
			await pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
			if (msg.data.sdp.type === 'offer') {
				const answer = await pc.createAnswer();
				await pc.setLocalDescription(answer);
				ws.send(JSON.stringify({ type: 'signal', to: msg.from, data: { sdp: pc.localDescription } }));
			}
		}
		if (msg.data.candidate) {
			try { await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate)); } catch {}
		}
	});

	window.WebRTCClient = {
		waitForOpen,
		join,
		startPublisher,
		startViewer,
		state,
	};
})(); 