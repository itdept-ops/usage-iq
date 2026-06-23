/**
 * Framework-free helpers for the tracker's VOICE capture (mic → spoken note → parse-only intents). Two
 * concerns, both DI-free so any dialog/component can call them directly:
 *
 *  1. On-device speech-to-text via the Web {@link SpeechRecognition} API — the PREFERRED path: the audio
 *     never leaves the device, only the resulting TEXT transcript is sent to the parse-only endpoint. See
 *     {@link speechSupported} / {@link recordTranscript}.
 *
 *  2. An inline-AUDIO fallback (MediaRecorder → a short base64 clip) for browsers without on-device STT.
 *     That path is sent to the server and is ai.vision-gated; the caller decides whether to offer it. See
 *     {@link mediaRecorderSupported} / {@link recordAudioClip}.
 *
 *  Plus {@link confirmVoiceNotice} — a one-time privacy notice (mirrors the photo-notice rule) so the user
 *  knows their words are processed by Google Gemini and are NOT stored by Usage IQ.
 *
 * Nothing here writes or stores anything: the transcript/clip is handed to the caller, who sends it to the
 * PARSE-ONLY endpoint and discards it.
 */

/** Max seconds we keep the mic open for an audio-clip fallback before auto-stopping (keeps clips small). */
const MAX_CLIP_SECONDS = 30;

/** Cap the audio clip at ~9 MB of base64 to stay under the server's 10 MB decode bound. */
const MAX_CLIP_BASE64 = 9_000_000;

/** localStorage key gating the one-time "your words go to Gemini" voice notice. */
const VOICE_NOTICE_KEY = 'usage_iq_ai_voice_notice';

/** The one-time notice copy shown before the FIRST voice use. */
const VOICE_NOTICE_TEXT =
  'Your words are sent to Google Gemini to understand what to log — they are not stored by Usage IQ. ' +
  'You always review and confirm before anything is logged.';

/** The vendor-prefixed SpeechRecognition constructor, when the browser exposes one. */
function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when the browser can transcribe speech on-device (the preferred, audio-never-leaves path). */
export function speechSupported(): boolean {
  return speechRecognitionCtor() != null;
}

/** True when the browser can record an audio clip we can send to the server (the ai.vision fallback). */
export function mediaRecorderSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder === 'function';
}

/** A handle to an in-flight recording: stop it (resolve the result) or abort (resolve null/discard). */
export interface VoiceRecording {
  /** Stop recording and resolve the pending promise with the final result. */
  stop(): void;
  /** Abort: stop the mic and resolve the pending promise with `null` (the user cancelled). */
  abort(): void;
}

/** A live partial transcript callback so the dialog can show words as they're recognised. */
export type InterimHandler = (text: string) => void;

/** A recognised transcript result. `text` is the (possibly empty) final transcript. */
export interface TranscriptResult {
  text: string;
}

/** A recorded audio clip (raw base64, NO `data:` prefix) + its mime type, for the inline-audio fallback. */
export interface AudioClipResult {
  audioBase64: string;
  mimeType: string;
}

/** A narrow structural type for the SpeechRecognition instance (avoids relying on lib.dom variance). */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

/**
 * Start on-device speech recognition. Returns `{ recording, done }`: `recording.stop()` ends capture and
 * resolves `done` with the accumulated transcript; `recording.abort()` resolves with `null` (cancelled).
 * `onInterim` (optional) streams the live partial transcript for display. REJECTS the `done` promise on a
 * permission-denied / no-speech / hardware error so the caller can surface a friendly message and offer
 * typing. The recogniser auto-ends on a natural pause; we resolve with whatever was captured.
 *
 * Throws synchronously when {@link speechSupported} is false — callers should check first.
 */
export function recordTranscript(onInterim?: InterimHandler): { recording: VoiceRecording; done: Promise<TranscriptResult | null> } {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) throw new Error('Speech recognition is not supported in this browser.');

  const rec = new Ctor();
  rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = '';
  let settled = false;
  let aborted = false;

  let resolveDone!: (r: TranscriptResult | null) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<TranscriptResult | null>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const settle = (run: () => void) => {
    if (settled) return;
    settled = true;
    run();
  };

  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const alt = ev.results[i]?.[0];
      const piece = alt?.transcript ?? '';
      // `isFinal` isn't in our narrow type; rely on accumulation — interim chunks are replaced each tick.
      const isFinal = (ev.results[i] as unknown as { isFinal?: boolean })?.isFinal === true;
      if (isFinal) finalText += piece;
      else interim += piece;
    }
    if (onInterim) onInterim((finalText + ' ' + interim).trim());
  };

  rec.onerror = (ev) => {
    const code = ev?.error ?? '';
    // A user-stopped/no-speech run isn't a hard error — resolve with what we have (often empty).
    if (code === 'no-speech' || code === 'aborted') {
      settle(() => resolveDone(aborted ? null : { text: finalText.trim() }));
      return;
    }
    const message = code === 'not-allowed' || code === 'service-not-allowed'
      ? 'Microphone access was blocked. Allow the mic, or type instead.'
      : 'Could not capture audio. Try again, or type instead.';
    settle(() => rejectDone(new Error(message)));
  };

  rec.onend = () => {
    settle(() => resolveDone(aborted ? null : { text: finalText.trim() }));
  };

  try {
    rec.start();
  } catch (e) {
    settle(() => rejectDone(e instanceof Error ? e : new Error('Could not start the microphone.')));
  }

  const recording: VoiceRecording = {
    stop: () => { try { rec.stop(); } catch { /* already ended */ } },
    abort: () => { aborted = true; try { rec.abort(); } catch { /* already ended */ } },
  };

  return { recording, done };
}

/**
 * Inline-audio fallback: record a short clip with MediaRecorder and return raw base64 + mime. Used only
 * when on-device STT is unavailable AND the caller has ai.vision (the server gates the audio path on it).
 * `recording.stop()` ends capture + resolves with the clip; `recording.abort()` resolves with `null`.
 * Auto-stops after {@link MAX_CLIP_SECONDS}. REJECTS on a permission/hardware error.
 *
 * Throws synchronously when {@link mediaRecorderSupported} is false — callers should check first.
 */
export function recordAudioClip(): { recording: VoiceRecording; done: Promise<AudioClipResult | null> } {
  if (!mediaRecorderSupported()) throw new Error('Audio recording is not supported in this browser.');

  let settled = false;
  let aborted = false;
  let resolveDone!: (r: AudioClipResult | null) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<AudioClipResult | null>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const settle = (run: () => void) => { if (!settled) { settled = true; run(); } };

  // The recorder + stream are created async (getUserMedia); expose a handle that defers stop/abort.
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let autoStop: ReturnType<typeof setTimeout> | null = null;
  let pendingStop = false;
  let pendingAbort = false;

  const stopTracks = () => { stream?.getTracks().forEach(t => t.stop()); };

  navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
    stream = s;
    const mime = pickAudioMime();
    try {
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
    } catch {
      recorder = new MediaRecorder(s);
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (autoStop) clearTimeout(autoStop);
      stopTracks();
      if (aborted) { settle(() => resolveDone(null)); return; }
      const type = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
      const blob = new Blob(chunks, { type });
      blobToBase64(blob).then((b64) => {
        if (b64.length > MAX_CLIP_BASE64) {
          settle(() => rejectDone(new Error('That clip is too long — try a shorter note.')));
          return;
        }
        settle(() => resolveDone({ audioBase64: b64, mimeType: type.split(';')[0] }));
      }, () => settle(() => rejectDone(new Error('Could not read the recording.'))));
    };
    recorder.onerror = () => settle(() => rejectDone(new Error('Recording failed. Try again, or type instead.')));

    recorder.start();
    autoStop = setTimeout(() => { try { recorder?.stop(); } catch { /* ignore */ } }, MAX_CLIP_SECONDS * 1000);

    // Honour a stop/abort that arrived before the mic was ready.
    if (pendingAbort) { aborted = true; try { recorder.stop(); } catch { /* ignore */ } }
    else if (pendingStop) { try { recorder.stop(); } catch { /* ignore */ } }
  }, () => {
    settle(() => rejectDone(new Error('Microphone access was blocked. Allow the mic, or type instead.')));
  });

  const recording: VoiceRecording = {
    stop: () => {
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
      else pendingStop = true;
    },
    abort: () => {
      aborted = true;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
      else { pendingAbort = true; stopTracks(); }
    },
  };

  return { recording, done };
}

/** Choose a MediaRecorder mime the server accepts (webm/ogg), falling back to the browser default. */
function pickAudioMime(): string | undefined {
  const candidates = ['audio/webm', 'audio/ogg'];
  const MR = (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  if (MR?.isTypeSupported) {
    for (const c of candidates) if (MR.isTypeSupported(c)) return c;
  }
  return undefined;
}

/** Read a Blob as raw base64 (NO `data:` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.readAsDataURL(blob);
  });
}

/** Has the one-time voice-privacy notice already been acknowledged? Lets a caller pre-check. */
export function voiceNoticeAcknowledged(): boolean {
  try {
    return localStorage.getItem(VOICE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Gate the FIRST voice use behind a one-time privacy notice (mirrors {@link confirmPhotoNotice}). Resolves
 * `true` immediately when already acknowledged; otherwise shows the {@link VOICE_NOTICE_TEXT} confirm and,
 * on accept, sets the flag + resolves `true`. On cancel resolves `false` WITHOUT setting the flag.
 */
export function confirmVoiceNotice(): Promise<boolean> {
  if (voiceNoticeAcknowledged()) return Promise.resolve(true);
  const proceed = typeof window !== 'undefined' && window.confirm(VOICE_NOTICE_TEXT);
  if (proceed) {
    try {
      localStorage.setItem(VOICE_NOTICE_KEY, '1');
    } catch {
      // Non-fatal: a blocked localStorage just re-shows the notice next time.
    }
  }
  return Promise.resolve(proceed);
}
