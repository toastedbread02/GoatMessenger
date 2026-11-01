// Voice and video calls.
//
// Handshake: each side publishes a fresh X25519 ephemeral key signed with its
// Ed25519 identity key. The call key is HKDF(ECDH(ephemerals), both public keys),
// and every SDP/ICE blob is AES-GCM sealed under it — so the relay only forwards
// ciphertext. Media itself is peer-to-peer (DTLS-SRTP); no TURN server relay.
import * as C from '../shared/crypto.mjs';
import { randomId } from './dom.mjs';

// Public STUN is only a convenience for finding a route; TURN (yours, from
// Settings) is what makes a call work between two home networks on different
// continents. Either way the media is DTLS-SRTP between the two apps.
const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const INVITE_TIMEOUT = 45000;

export class CallManager {
  constructor(opts) {
    this.signal = opts.signal;          // (payload) -> void
    this.bundleFor = opts.bundleFor;    // async (peer) -> public key bundle
    this.onState = opts.onState || (() => {});
    this.onIncoming = opts.onIncoming || (() => {});
    this.onEnd = opts.onEnd || (() => {});
    this.onRemoteStream = opts.onRemoteStream || (() => {});
    this.onLocalStream = opts.onLocalStream || (() => {});
    this.onTick = opts.onTick || (() => {});
    this.sound = opts.sound;
    this.identity = opts.identity;
    this.call = null;
    this.timeout = null;
    this.ticker = null;
    this.sendQueue = Promise.resolve();
    this.lastError = null;
    this.onPeerShare = opts.onPeerShare || (() => {});
    this.iceServers = DEFAULT_ICE;
    this.icePolicy = 'all';
  }

  // Called with the Settings values: a TURN URL/credentials, or nothing.
  setNetwork({ turn, forceRelay } = {}) {
    const servers = [];
    const urls = String(turn?.urls || '').split(/[,\s]+/).filter(Boolean);
    if (urls.length) {
      servers.push({
        urls,
        username: turn?.username || undefined,
        credential: turn?.credential || undefined,
      });
    }
    servers.push(...DEFAULT_ICE);
    this.iceServers = servers;
    this.icePolicy = forceRelay ? 'relay' : 'all';
  }

  hasTurn() {
    return this.iceServers.some((s) => [].concat(s.urls).some((u) => String(u).startsWith('turn')));
  }

  get active() { return Boolean(this.call); }
  get current() { return this.call; }

  emit(extra = {}) {
    if (!this.call) return;
    this.onState({
      id: this.call.id,
      peer: this.call.peer,
      kind: this.call.kind,
      direction: this.call.direction,
      state: this.call.state,
      muted: this.call.muted,
      cameraOn: this.call.cameraOn,
      code: this.call.code || '',
      duration: this.call.durationSec || 0,
      hasVideo: this.call.kind === 'video',
      sharing: this.call.sharing,
      peerSharing: this.call.peerSharing,
      useTurn: this.hasTurn(),
      ...extra,
    });
  }

  /* ------------------------------------------------------------------ media -- */

  async getUserMediaWithRetry(constraints) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        last = err;
        // A hard denial will not change on retry; a busy device often will.
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw last;
  }

  async getMedia(kind) {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    try {
      return await this.getUserMediaWithRetry({
        audio,
        video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
      });
    } catch (err) {
      if (kind === 'video' && err.name !== 'NotAllowedError') {
        // Camera missing/blocked: fall back to a voice call rather than failing.
        const stream = await this.getUserMediaWithRetry({ audio, video: false });
        this.lastError = 'No camera — continuing with voice only.';
        return stream;
      }
      throw err;
    }
  }

  startTimers() {
    clearTimeout(this.timeout);
    clearInterval(this.ticker);
    this.timeout = setTimeout(() => {
      if (!this.call) return;
      if (this.call.state === 'inviting') this.finish('no-answer');
      else if (this.call.state === 'incoming') this.finish('missed');
      else if (this.call.state === 'connecting') this.finish('failed');
    }, INVITE_TIMEOUT);
    this.ticker = setInterval(() => {
      if (!this.call || this.call.state !== 'connected') return;
      this.call.durationSec = Math.floor((Date.now() - this.call.connectedAt) / 1000);
      this.onTick(this.call.durationSec);
    }, 1000);
  }

  /* -------------------------------------------------------------- outgoing --- */

  async start(peer, kind = 'audio') {
    if (this.call) throw new Error('You are already in a call.');
    const bundle = await this.bundleFor(peer);
    if (!bundle) throw new Error('No verified key bundle for this goat.');

    const localStream = await this.getMedia(kind);
    const ep = C.createCallEphemeral();
    const epSig = C.signCallEphemeral(this.identity, ep.pub);

    this.call = {
      id: randomId(8),
      peer,
      kind,
      direction: 'out',
      state: 'inviting',
      epPriv: ep.priv,
      epPub: ep.pub,
      callKey: null,
      code: '',
      pc: null,
      localStream,
      remoteStream: null,
      muted: false,
      cameraOn: kind === 'video',
      cameraTrack: null,
      videoTx: null,
      sharing: false,
      screenStream: null,
      peerSharing: false,
      connectedAt: 0,
      durationSec: 0,
      pendingCandidates: [],
      bufferedBlobs: [],
      offerSent: false,
    };
    this.onLocalStream(localStream);
    this.emit();
    this.sound.dialStart();
    this.startTimers();

    this.signal({
      t: 'call',
      action: 'invite',
      callId: this.call.id,
      to: peer,
      kind,
      ep: ep.pub,
      epSig,
    });
    return true;
  }

  /* -------------------------------------------------------------- incoming --- */

  async handleIncomingInvite(msg) {
    if (this.call) {
      // Busy: politely decline without disturbing the current call.
      this.signal({ t: 'call', action: 'decline', callId: msg.callId, to: msg.from });
      return;
    }
    const bundle = await this.bundleFor(msg.from);
    if (!bundle) {
      this.signal({ t: 'call', action: 'decline', callId: msg.callId, to: msg.from });
      return;
    }
    if (!C.verifyCallEphemeral(bundle, msg.ep, msg.epSig)) {
      this.signal({ t: 'call', action: 'decline', callId: msg.callId, to: msg.from });
      this.onEnd({ peer: msg.from, outcome: 'failed', reason: 'bad-signature' });
      return;
    }
    this.call = {
      id: msg.callId,
      peer: msg.from,
      kind: msg.kind === 'video' ? 'video' : 'audio',
      direction: 'in',
      state: 'incoming',
      peerEpPub: msg.ep,
      epPriv: null,
      epPub: null,
      callKey: null,
      code: '',
      pc: null,
      localStream: null,
      remoteStream: null,
      muted: false,
      cameraOn: msg.kind === 'video',
      cameraTrack: null,
      videoTx: null,
      sharing: false,
      screenStream: null,
      peerSharing: false,
      connectedAt: 0,
      durationSec: 0,
      pendingCandidates: [],
      bufferedBlobs: [],
    };
    this.emit();
    this.sound.ringStart();
    this.startTimers();
    this.onIncoming({ peer: msg.from, kind: this.call.kind, id: this.call.id });
  }

  async accept() {
    const call = this.call;
    if (!call || call.direction !== 'in' || call.state !== 'incoming') return;
    this.sound.stopRing();
    clearTimeout(this.timeout);
    try {
      call.localStream = await this.getMedia(call.kind);
    } catch (err) {
      this.signal({ t: 'call', action: 'decline', callId: call.id, to: call.peer });
      this.finish('failed', 'no-media');
      throw err;
    }
    this.onLocalStream(call.localStream);

    const ep = C.createCallEphemeral();
    call.epPriv = ep.priv;
    call.epPub = ep.pub;
    call.epSig = C.signCallEphemeral(this.identity, ep.pub);
    call.callKey = C.deriveCallKey(ep.priv, call.peerEpPub, call.peerEpPub, ep.pub);
    call.code = C.callSafetyCode(call.callKey);
    call.state = 'connecting';
    this.emit();

    this.signal({
      t: 'call', action: 'accept', callId: call.id, to: call.peer, ep: ep.pub, epSig: call.epSig,
    });
    this.createPeerConnection();
    await this.drainBufferedBlobs();
    this.startTimers();
  }

  decline() {
    const call = this.call;
    if (!call) return;
    this.signal({ t: 'call', action: 'decline', callId: call.id, to: call.peer });
    this.finish('declined');
  }

  hangup() {
    const call = this.call;
    if (!call) return;
    const action = call.state === 'inviting' ? 'cancel' : 'hangup';
    this.signal({ t: 'call', action, callId: call.id, to: call.peer });
    this.finish(call.state === 'connected' ? 'completed' : 'cancelled');
  }

  /* ---------------------------------------------------------------- signal --- */

  async enqueueSignal(payload) {
    const call = this.call;
    if (!call) return;
    this.sendQueue = this.sendQueue.then(async () => {
      if (!this.call || this.call.id !== call.id || !call.callKey) return;
      const blob = await C.encryptSignal(call.callKey, payload);
      this.signal({ t: 'call', action: 'signal', callId: call.id, to: call.peer, blob });
    }).catch(() => {});
    return this.sendQueue;
  }

  async handle(msg) {
    const { action } = msg;
    if (action === 'invite') return this.handleIncomingInvite(msg);

    const call = this.call;
    if (!call || call.id !== msg.callId) {
      if (action === 'decline' || action === 'hangup') return;
      return;
    }

    if (action === 'accept' && call.direction === 'out') {
      const bundle = await this.bundleFor(call.peer);
      if (!C.verifyCallEphemeral(bundle, msg.ep, msg.epSig)) {
        this.finish('failed', 'bad-signature');
        return;
      }
      call.peerEpPub = msg.ep;
      call.callKey = C.deriveCallKey(call.epPriv, msg.ep, call.epPub, msg.ep);
      call.code = C.callSafetyCode(call.callKey);
      call.state = 'connecting';
      this.sound.stopDial();
      this.emit();
      this.createPeerConnection();
      try {
        const offer = await call.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: call.kind === 'video' });
        await call.pc.setLocalDescription(offer);
        await this.enqueueSignal({ kind: 'sdp', sdp: call.pc.localDescription });
      } catch (err) {
        this.finish('failed', 'offer');
        return;
      }
      await this.drainBufferedBlobs();
      return;
    }

    if (action === 'decline') {
      this.finish(call.direction === 'out' ? 'declined' : 'cancelled');
      return;
    }
    if (action === 'cancel') {
      this.finish('missed');
      return;
    }
    if (action === 'hangup') {
      this.finish(call.state === 'connected' ? 'completed' : 'cancelled');
      return;
    }
    if (action === 'signal') {
      if (!call.callKey) {
        call.bufferedBlobs.push(msg.blob);
        return;
      }
      await this.handleBlob(msg.blob);
    }
  }

  async drainBufferedBlobs() {
    const call = this.call;
    if (!call) return;
    const blobs = call.bufferedBlobs.splice(0);
    for (const blob of blobs) await this.handleBlob(blob);
  }

  async handleBlob(blob) {
    const call = this.call;
    if (!call || !call.callKey) return;
    let payload;
    try {
      payload = await C.decryptSignal(call.callKey, blob);
    } catch {
      return; // forged or stale — ignore rather than kill the call
    }
    if (payload.kind === 'sdp') {
      if (!call.pc) this.createPeerConnection();
      try {
        await call.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this.flushCandidates();
        if (payload.sdp.type === 'offer') {
          this.attachVideoSlot();
          const answer = await call.pc.createAnswer();
          await call.pc.setLocalDescription(answer);
          await this.enqueueSignal({ kind: 'sdp', sdp: call.pc.localDescription });
        }
      } catch (err) {
        this.finish('failed', 'sdp');
      }
      return;
    }
    if (payload.kind === 'screen') {
      call.peerSharing = Boolean(payload.on);
      this.onPeerShare(call.peerSharing);
      this.emit();
      return;
    }
    if (payload.kind === 'ice' && payload.candidate) {
      if (!call.pc || !call.pc.remoteDescription) {
        call.pendingCandidates.push(payload.candidate);
        return;
      }
      try {
        await call.pc.addIceCandidate(payload.candidate);
      } catch { /* some candidates legitimately fail */ }
    }
  }

  // Callee side: take the video transceiver the offer created and enable it.
  attachVideoSlot() {
    const call = this.call;
    if (!call || !call.pc || call.videoTx) return;
    const tx = call.pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'video');
    if (!tx) return;
    tx.direction = 'sendrecv';
    call.videoTx = tx;
    if (call.cameraTrack) tx.sender.replaceTrack(call.cameraTrack);
  }

  async flushCandidates() {
    const call = this.call;
    if (!call || !call.pc) return;
    const pending = call.pendingCandidates.splice(0);
    for (const cand of pending) {
      try { await call.pc.addIceCandidate(cand); } catch {}
    }
  }

  /* ------------------------------------------------------------------- rtc --- */

  createPeerConnection() {
    const call = this.call;
    if (!call || call.pc) return call && call.pc;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.icePolicy,
      iceCandidatePoolSize: 2,
      bundlePolicy: 'max-bundle',
    });
    call.pc = pc;

    const audio = call.localStream?.getAudioTracks?.() || [];
    for (const track of audio) pc.addTrack(track, call.localStream);
    call.cameraTrack = (call.localStream?.getVideoTracks?.() || [])[0] || null;

    // The caller creates one video slot even on a voice call, so screen sharing
    // is a track swap instead of a renegotiation mid-call. The callee adopts the
    // slot from the offer (addVideoSlot) so both sides' SDP lines up.
    if (call.direction === 'out') {
      call.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
      if (call.cameraTrack) call.videoTx.sender.replaceTrack(call.cameraTrack);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) this.enqueueSignal({ kind: 'ice', candidate: event.candidate.toJSON() });
    };

    pc.ontrack = (event) => {
      // Audio arrives with its stream id; a swap-in video track (camera or
      // screen) arrives without one, so collect both into a single stream.
      let stream = event.streams[0];
      if (stream) {
        call.remoteStream = stream;
      } else {
        if (!call.remoteStream) call.remoteStream = new MediaStream();
        stream = call.remoteStream;
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      }
      this.onRemoteStream(call.remoteStream, call.kind);
      const audioEl = document.getElementById('remote-audio');
      if (audioEl && audioEl.srcObject !== call.remoteStream) {
        audioEl.srcObject = call.remoteStream;
        audioEl.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (!this.call || this.call.id !== call.id) return;
      if (pc.connectionState === 'connected') {
        if (call.state !== 'connected') {
          call.state = 'connected';
          call.connectedAt = Date.now();
          clearTimeout(this.timeout);
          this.sound.stopDial();
          this.sound.connect();
          this.emit();
        }
      } else if (pc.connectionState === 'failed') {
        this.finish('failed', 'ice');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!this.call || this.call.id !== call.id) return;
      if (pc.iceConnectionState === 'disconnected') {
        setTimeout(() => {
          if (this.call && this.call.id === call.id && this.call.pc && this.call.pc.iceConnectionState === 'disconnected') {
            this.finish('failed', 'disconnected');
          }
        }, 12000);
      }
    };

    return pc;
  }

  /* -------------------------------------------------------------- controls --- */

  toggleMute() {
    const call = this.call;
    if (!call || !call.localStream) return false;
    call.muted = !call.muted;
    for (const track of call.localStream.getAudioTracks()) track.enabled = !call.muted;
    this.emit();
    return call.muted;
  }

  toggleCamera() {
    const call = this.call;
    if (!call || !call.cameraTrack) return false;
    if (call.sharing) {
      // While sharing, the camera button restores the camera instead.
      this.stopShare();
      return true;
    }
    call.cameraOn = !call.cameraOn;
    call.cameraTrack.enabled = call.cameraOn;
    this.emit();
    return call.cameraOn;
  }

  /* ------------------------------------------------------------ screen share */

  async startShare(sourceId, partition) {
    const call = this.call;
    if (!call || !call.pc) throw new Error('Start the call first.');
    if (call.sharing) return true;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is unavailable here.');
    if (sourceId && window.goat?.screen?.pick) await window.goat.screen.pick(sourceId, partition);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No screen was captured.');
    call.screenStream = stream;
    call.sharing = true;
    call.videoTx.sender.replaceTrack(track).catch(() => {});
    track.onended = () => { this.stopShare().catch(() => {}); };
    this.onLocalStream(stream);
    this.enqueueSignal({ kind: 'screen', on: true });
    this.emit();
    return true;
  }

  async stopShare() {
    const call = this.call;
    if (!call || !call.sharing) return false;
    call.sharing = false;
    for (const track of call.screenStream?.getTracks?.() || []) track.stop();
    call.screenStream = null;
    await call.videoTx?.sender?.replaceTrack(call.cameraTrack || null).catch(() => {});
    this.onLocalStream(call.localStream);
    this.enqueueSignal({ kind: 'screen', on: false });
    this.emit();
    return true;
  }

  /* ------------------------------------------------------------------ teardown */

  finish(outcome, reason = '') {
    const call = this.call;
    if (!call) return;
    this.call = null;
    clearTimeout(this.timeout);
    clearInterval(this.ticker);
    this.sound.stopDial();
    this.sound.stopRing();
    if (outcome === 'completed' || outcome === 'failed') this.sound.end();

    try {
      if (call.pc) {
        call.pc.onicecandidate = null;
        call.pc.ontrack = null;
        call.pc.onconnectionstatechange = null;
        call.pc.close();
      }
    } catch {}
    for (const track of call.localStream?.getTracks?.() || []) track.stop();
    for (const track of call.screenStream?.getTracks?.() || []) track.stop();

    const audioEl = document.getElementById('remote-audio');
    if (audioEl) audioEl.srcObject = null;
    const videoEl = document.getElementById('remote-video');
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.classList.remove('live');
    }

    this.onEnd({
      id: call.id,
      peer: call.peer,
      kind: call.kind,
      direction: call.direction,
      outcome,
      reason,
      durationSec: call.durationSec || 0,
      connected: call.state === 'connected',
    });
  }

  reset() {
    if (this.call) this.finish('cancelled');
  }
}
