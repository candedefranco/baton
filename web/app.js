import { createEngine, volumeFromPinch, palmCenter, syntheticHand, HAND_CONNECTIONS } from "./gestures.js";

const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const TOKEN = document.querySelector('meta[name="baton-token"]').content;
// ?demo: a synthetic hand performs the gestures, no camera needed. Against a
// real player it only pretends, so it never touches your music.
const DEMO = new URLSearchParams(location.search).has("demo");

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d");
const video = $("video");

const COLORS = { idle: "#79c0ff", hold: "#3fb950", pinch: "#ffa657", none: "#79c0ff" };
const ICONS = { playpause: "⏯", next: "⏭", previous: "⏮" };

let player = { app: "", playing: false, track: "", artist: "", volume: 0, dryRun: false };
let engine = createEngine({ aspect: canvas.width / canvas.height });
let lastFrame = null;

// ---------- server ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "X-Baton-Token": TOKEN, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server said ${res.status}`);
  return data;
}

async function refresh() {
  try {
    player = await api("/api/state");
    setBanner("");
  } catch (err) {
    setBanner(err.message);
  }
  renderPlayer();
}

const live = () => !DEMO || player.dryRun;

async function command(action) {
  flash(ICONS[action]);
  if (action !== "playpause") pulse("g-swipe");
  if (!live()) {
    log(`${action} (demo)`, "cmd");
    return;
  }
  try {
    await api("/api/action", { action });
    log(action, "cmd");
    setTimeout(refresh, 350); // give the app a moment to change track
  } catch (err) {
    log(err.message, "err");
    setBanner(err.message);
  }
}

// While pinching, the volume follows the hand: the bar updates every frame,
// the server at most every 90 ms, and once more with the final value.
let pinchStart = 0;
let liveVolume = null;
let sentVolume = null;
let volumeTimer = 0;

function flushVolume() {
  volumeTimer = 0;
  if (liveVolume === null || liveVolume === sentVolume) return;
  sentVolume = liveVolume;
  if (live()) api("/api/action", { action: "volume", value: sentVolume }).catch((err) => setBanner(err.message));
  volumeTimer = setTimeout(flushVolume, 90);
}

function handle(ev) {
  switch (ev.type) {
    case "playpause":
    case "next":
    case "previous":
      command(ev.type);
      break;
    case "pinch-start":
      pinchStart = player.volume;
      liveVolume = pinchStart;
      break;
    case "pinch-move":
      liveVolume = volumeFromPinch(pinchStart, ev.dy);
      if (!volumeTimer) flushVolume();
      break;
    case "pinch-end":
      if (liveVolume !== null) {
        clearTimeout(volumeTimer);
        flushVolume();
        clearTimeout(volumeTimer);
        volumeTimer = 0;
        if (liveVolume !== pinchStart) log(`volume ${liveVolume}${live() ? "" : " (demo)"}`, "cmd");
        player.volume = liveVolume;
        liveVolume = null;
      }
      break;
  }
  renderPlayer();
}

// ---------- page ----------

function renderPlayer() {
  $("np-app").textContent = player.app || "no player open";
  $("np-state").textContent = player.playing ? "▶" : "■";
  $("np-state").classList.toggle("playing", player.playing);
  $("np-track").textContent = player.track || (player.app ? "nothing playing" : "open Spotify or Music");
  $("np-artist").textContent = player.artist;
  const v = liveVolume ?? player.volume;
  $("vol-fill").style.width = `${v}%`;
  $("vol-num").textContent = v;
  document.querySelector(".volume").classList.toggle("live", liveVolume !== null);
}

function renderGestures() {
  const { mode } = engine.state;
  $("g-hold").classList.toggle("active", mode === "hold");
  $("g-pinch").classList.toggle("active", mode === "pinch");
}

function pulse(id) {
  $(id).classList.add("active");
  setTimeout(() => $(id).classList.remove("active"), 500);
}

let flashTimer = 0;
function flash(icon) {
  const el = $("flash");
  el.textContent = icon;
  el.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("show"), 450);
}

function log(text, cls = "") {
  const li = document.createElement("li");
  const time = new Date().toTimeString().slice(0, 8);
  li.innerHTML = `<span class="time">[${time}]</span> <span class="${cls}"></span>`;
  li.lastChild.textContent = text;
  $("log").prepend(li);
  while ($("log").children.length > 8) $("log").lastChild.remove();
}

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = `status ${cls}`;
}

function setBanner(text) {
  $("banner").textContent = text;
  $("banner").hidden = !text;
}

// ---------- drawing ----------

function draw(frame) {
  const { width: w, height: h } = canvas;
  if (DEMO || !video.videoWidth) {
    ctx.fillStyle = "#010409";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#21262d";
    for (let x = 20; x < w; x += 40) for (let y = 20; y < h; y += 40) ctx.fillRect(x, y, 2, 2);
  } else {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1); // a mirror, so moving right moves right
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = "rgba(1, 4, 9, 0.35)";
    ctx.fillRect(0, 0, w, h);
  }

  const pts = frame?.points;
  if (!pts) return;
  const P = (i) => [pts[i].x * w, pts[i].y * h];
  const { mode, holdProgress } = engine.state;
  const color = COLORS[mode];
  const scale = h / 720;

  ctx.lineCap = "round";
  ctx.lineWidth = 4 * scale;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12 * scale;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(...P(a));
    ctx.lineTo(...P(b));
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#e6edf3";
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(...P(i), 4 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  const c = palmCenter(pts);
  const [cx, cy] = [c.x * w, c.y * h];
  if (mode === "hold") {
    ctx.lineWidth = 6 * scale;
    ctx.strokeStyle = "rgba(63, 185, 80, 0.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, 70 * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COLORS.hold;
    ctx.beginPath();
    ctx.arc(cx, cy, 70 * scale, -Math.PI / 2, -Math.PI / 2 + holdProgress * Math.PI * 2);
    ctx.stroke();
  }
  if (mode === "pinch") {
    const [tx, ty] = P(4);
    const [ix, iy] = P(8);
    ctx.fillStyle = COLORS.pinch;
    ctx.beginPath();
    ctx.arc((tx + ix) / 2, (ty + iy) / 2, 10 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 ${Math.round(28 * scale)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "right"; // to the left of the fingertips, clear of the hand
    ctx.fillText(`vol ${liveVolume ?? player.volume}`, (tx + ix) / 2 - 22 * scale, (ty + iy) / 2 + 10 * scale);
    ctx.textAlign = "left";
  }
  ctx.font = `${Math.round(18 * scale)}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = "#8b949e";
  ctx.fillText(frame.gesture.replace("_", " ").toLowerCase(), 16 * scale, h - 18 * scale);
}

// ---------- demo hand ----------

// One loop of the demo: [start, end, from, to] in seconds, poses as
// { x, y, pinch }, null for no hand. Odd loops mirror it: the swipe goes
// left and the pinch turns the volume down.
const DEMO_LOOP = 8.6;
function demoScript(odd) {
  const X = (x) => (odd ? 1 - x : x);
  const up = odd ? [0.42, 0.68] : [0.68, 0.42];
  return [
    [0, 0.8, null, null],
    [0.8, 1.25, { x: X(0.5), y: 1.2 }, { x: X(0.5), y: 0.55 }],
    [1.25, 2.4, { x: X(0.5), y: 0.55 }, { x: X(0.5), y: 0.55 }],
    [2.4, 3.0, { x: X(0.5), y: 0.55 }, { x: X(0.3), y: 0.55 }],
    [3.0, 3.4, { x: X(0.3), y: 0.55 }, { x: X(0.3), y: 0.55 }],
    [3.4, 3.65, { x: X(0.3), y: 0.55 }, { x: X(0.75), y: 0.55 }],
    [3.65, 4.3, { x: X(0.75), y: 0.55 }, { x: X(0.75), y: 0.55 }],
    [4.3, 5.0, { x: X(0.75), y: 0.55 }, { x: X(0.5), y: up[0] }],
    [5.0, 5.3, { x: X(0.5), y: up[0], pinch: 0 }, { x: X(0.5), y: up[0], pinch: 1 }],
    [5.3, 6.6, { x: X(0.5), y: up[0], pinch: 1 }, { x: X(0.5), y: up[1], pinch: 1 }],
    [6.6, 6.9, { x: X(0.5), y: up[1], pinch: 1 }, { x: X(0.5), y: up[1], pinch: 0 }],
    [6.9, 7.5, { x: X(0.5), y: up[1] }, { x: X(0.5), y: 1.2 }],
    [7.5, DEMO_LOOP, null, null],
  ];
}

const ease = (k) => k * k * (3 - 2 * k);
const demoStart = performance.now();

function demoFrame(now) {
  const t = (now - demoStart) / 1000;
  const loop = Math.floor(t / DEMO_LOOP);
  const s = t - loop * DEMO_LOOP;
  const step = demoScript(loop % 2 === 1).find(([a, b]) => s >= a && s < b);
  if (!step || !step[2]) return { t: now, gesture: "None", points: null };
  const [a, b, from, to] = step;
  const k = ease((s - a) / (b - a));
  const mix = (key, d) => (from[key] ?? d) + ((to[key] ?? d) - (from[key] ?? d)) * k;
  const pinch = mix("pinch", 0);
  return {
    t: now,
    gesture: pinch > 0.5 ? "None" : "Open_Palm",
    points: syntheticHand(mix("x", 0.5), mix("y", 0.5), { pinch, aspect: canvas.width / canvas.height }),
  };
}

// ---------- camera ----------

let recognizer = null;
let delegate = "GPU";
let lastVideoTime = -1;

async function createRecognizer(vision, files, d) {
  delegate = d;
  return vision.GestureRecognizer.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate: d },
    runningMode: "VIDEO",
    numHands: 1,
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser can't use the camera");
  setStatus("asking for the camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  engine = createEngine({ aspect: video.videoWidth / video.videoHeight });

  setStatus("loading the hand model…");
  const vision = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const files = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  try {
    recognizer = await createRecognizer(vision, files, "GPU");
  } catch {
    recognizer = await createRecognizer(vision, files, "CPU");
  }
  setStatus("ready: show me your hand ✋", "ok");
  return { vision, files };
}

function cameraFrame(now, mp) {
  if (!recognizer || video.readyState < 2 || video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;
  let result;
  try {
    result = recognizer.recognizeForVideo(video, now);
  } catch (err) {
    // Some GPUs fail at runtime rather than at startup: fall back once.
    if (delegate === "GPU") {
      recognizer = null;
      createRecognizer(mp.vision, mp.files, "CPU").then((r) => (recognizer = r));
      return null;
    }
    throw err;
  }
  const lm = result.landmarks?.[0];
  return {
    t: now,
    gesture: result.gestures?.[0]?.[0]?.categoryName ?? "None",
    points: lm ? lm.map((p) => ({ x: 1 - p.x, y: p.y })) : null,
  };
}

// ---------- main ----------

function loop(mp) {
  const tick = (now) => {
    const frame = DEMO ? demoFrame(now) : cameraFrame(now, mp);
    if (frame) {
      lastFrame = frame;
      for (const ev of engine.update(frame)) handle(ev);
      renderGestures();
    }
    draw(lastFrame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

document.addEventListener("keydown", (e) => {
  const step = (d) => {
    player.volume = Math.max(0, Math.min(100, player.volume + d));
    renderPlayer();
    if (live()) api("/api/action", { action: "volume", value: player.volume }).catch((err) => setBanner(err.message));
  };
  const keys = {
    " ": () => command("playpause"),
    ArrowRight: () => command("next"),
    ArrowLeft: () => command("previous"),
    ArrowUp: () => step(5),
    ArrowDown: () => step(-5),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});

async function main() {
  await refresh();
  setInterval(refresh, 1500);
  if (DEMO) {
    $("stage-title").textContent = "demo · synthetic hand";
    setStatus(player.dryRun ? "demo (dry run)" : "demo: pretending, your music is safe", "warn");
    loop(null);
    return;
  }
  try {
    const mp = await startCamera();
    loop(mp);
  } catch (err) {
    setStatus("no camera", "err");
    setBanner(`${err.message}. Allow the camera and reload, or open ?demo to see the gestures.`);
    draw(null);
  }
}

main();
