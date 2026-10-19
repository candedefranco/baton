// Gesture logic: turns a stream of hand frames into music commands.
//
// It has no idea about cameras or the DOM, so it can be tested with synthetic
// hands (see gestures.test.js) and replayed in the ?demo page.
//
// A frame is { t, gesture, points }:
//   t        time in ms
//   gesture  MediaPipe's label for the hand ("Open_Palm", "Closed_Fist", ...)
//   points   the 21 hand landmarks, {x, y} in 0..1, x already mirrored so it
//            grows toward the user's right; null when no hand is in view.

// Hold an open palm still this long to play/pause.
export const HOLD_MS = 600;
// How far the palm may drift during a hold, in frame heights.
export const HOLD_DRIFT = 0.04;
// A swipe covers this share of the frame's width within SWIPE_MS.
export const SWIPE_DISTANCE = 0.2;
export const SWIPE_MS = 350;
// After a command, ignore new ones for a moment.
export const COOLDOWN_MS = 800;
// Thumb–index distance, in palm sizes, to start and to end a pinch. Ending
// takes a wider gap than starting, so a pinch doesn't flicker on and off.
export const PINCH_ON = 0.3;
export const PINCH_OFF = 0.45;
// Volume points per frame height of pinch movement.
export const VOLUME_PER_HEIGHT = 150;

const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9, RING_MCP = 13, PINKY_MCP = 17;

// Distances are measured with x scaled by the frame's aspect ratio, so a
// pinch reads the same however wide the camera is.
function dist(a, b, aspect) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

export function palmCenter(points) {
  const ids = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  return {
    x: ids.reduce((s, i) => s + points[i].x, 0) / ids.length,
    y: ids.reduce((s, i) => s + points[i].y, 0) / ids.length,
  };
}

// pinchRatio is the thumb–index gap relative to the size of the palm.
export function pinchRatio(points, aspect) {
  const palm = dist(points[WRIST], points[MIDDLE_MCP], aspect);
  return palm > 0 ? dist(points[THUMB_TIP], points[INDEX_TIP], aspect) / palm : Infinity;
}

function pinchPoint(points) {
  return {
    x: (points[THUMB_TIP].x + points[INDEX_TIP].x) / 2,
    y: (points[THUMB_TIP].y + points[INDEX_TIP].y) / 2,
  };
}

// volumeFromPinch maps how far the pinch moved up (dy, in frame heights) onto
// the volume it started at.
export function volumeFromPinch(start, dy) {
  return Math.max(0, Math.min(100, Math.round(start + dy * VOLUME_PER_HEIGHT)));
}

// createEngine returns { update(frame) → events, state }. Events:
//   { type: "playpause" | "next" | "previous" }
//   { type: "pinch-start" }, { type: "pinch-move", dy }, { type: "pinch-end" }
// state describes what the hand is doing, for the UI:
//   { mode: "none" | "idle" | "hold" | "pinch", holdProgress: 0..1 }
export function createEngine({ aspect = 16 / 9 } = {}) {
  let trail = []; // recent palm centers, for swipes
  let hold = null; // where and when the current palm hold started
  let holdArmed = true; // false until the palm closes again after a command
  let pinch = null; // { y } where the pinch started
  let cooldownUntil = 0;
  let state = { mode: "none", holdProgress: 0 };

  function reset() {
    trail = [];
    hold = null;
  }

  function update({ t, gesture, points }) {
    const events = [];

    if (!points) {
      if (pinch) events.push({ type: "pinch-end" });
      pinch = null;
      holdArmed = true;
      reset();
      state = { mode: "none", holdProgress: 0 };
      return events;
    }

    // Pinch: volume knob. Takes over until the fingers open again.
    const ratio = pinchRatio(points, aspect);
    if (pinch) {
      if (ratio > PINCH_OFF) {
        events.push({ type: "pinch-end" });
        pinch = null;
      } else {
        events.push({ type: "pinch-move", dy: pinch.y - pinchPoint(points).y });
        state = { mode: "pinch", holdProgress: 0 };
        return events;
      }
    } else if (ratio < PINCH_ON) {
      pinch = { y: pinchPoint(points).y };
      reset();
      events.push({ type: "pinch-start" });
      state = { mode: "pinch", holdProgress: 0 };
      return events;
    }

    const c = palmCenter(points);

    // Swipe: the palm crosses a good part of the frame quickly.
    trail.push({ t, x: c.x, y: c.y });
    trail = trail.filter((p) => t - p.t <= SWIPE_MS);
    const first = trail[0];
    const dx = c.x - first.x;
    const dy = c.y - first.y;
    if (t >= cooldownUntil && Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < Math.abs(dx) * 0.7) {
      events.push({ type: dx > 0 ? "next" : "previous" });
      cooldownUntil = t + COOLDOWN_MS;
      holdArmed = false; // a hand left open after a swipe shouldn't also pause
      reset();
      state = { mode: "idle", holdProgress: 0 };
      return events;
    }

    // Hold: an open palm kept still.
    if (gesture !== "Open_Palm") {
      holdArmed = true;
      hold = null;
    } else if (holdArmed && t >= cooldownUntil) {
      if (!hold || Math.hypot((c.x - hold.x) * aspect, c.y - hold.y) > HOLD_DRIFT) {
        hold = { t, x: c.x, y: c.y };
      } else if (t - hold.t >= HOLD_MS) {
        events.push({ type: "playpause" });
        cooldownUntil = t + COOLDOWN_MS;
        holdArmed = false;
        hold = null;
      }
    }
    state = {
      mode: hold ? "hold" : "idle",
      holdProgress: hold ? Math.min(1, (t - hold.t) / HOLD_MS) : 0,
    };
    return events;
  }

  return {
    update,
    get state() {
      return state;
    },
  };
}

// An open right hand, palm facing the camera, in palm-relative units with
// the wrist at the bottom. syntheticHand places it in the frame.
const OPEN = [
  [0, 0.5], [-0.12, 0.42], [-0.22, 0.32], [-0.3, 0.22], [-0.36, 0.13],
  [-0.1, 0.1], [-0.12, -0.08], [-0.13, -0.19], [-0.14, -0.29],
  [0, 0.08], [0, -0.12], [0, -0.24], [0, -0.35],
  [0.09, 0.1], [0.11, -0.07], [0.12, -0.18], [0.13, -0.27],
  [0.17, 0.15], [0.21, 0.02], [0.23, -0.06], [0.25, -0.14],
];
// The same hand with the thumb and index tips touching.
const PINCHED = OPEN.map((p, i) => ({
  3: [-0.25, 0.24], 4: [-0.2, 0.14], 6: [-0.13, -0.02], 7: [-0.17, 0.06], 8: [-0.19, 0.13],
})[i] ?? p);

// syntheticHand returns 21 landmarks for a hand whose palm is centered near
// (x, y), `size` frame heights tall. pinch blends from open (0) to pinched (1).
export function syntheticHand(x, y, { pinch = 0, size = 0.42, aspect = 16 / 9 } = {}) {
  return OPEN.map(([ox, oy], i) => {
    const [px, py] = PINCHED[i];
    const hx = ox + (px - ox) * pinch;
    const hy = oy + (py - oy) * pinch;
    return { x: x + (hx * size) / aspect, y: y + (hy - 0.15) * size };
  });
}

// The pairs of landmarks joined when drawing a hand.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
