import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEngine, syntheticHand, pinchRatio, palmCenter, volumeFromPinch,
  HOLD_MS, COOLDOWN_MS, PINCH_ON, PINCH_OFF, SWIPE_MS,
} from "./gestures.js";

const FPS = 30;
const STEP = 1000 / FPS;

// play feeds an engine a timeline of hand poses and collects the commands.
// pose(t) returns { x, y, pinch, gesture } or null for "no hand".
function play(engine, from, to, pose) {
  const events = [];
  for (let t = from; t < to; t += STEP) {
    const p = pose(t);
    const frame = p
      ? { t, gesture: p.gesture ?? "Open_Palm", points: syntheticHand(p.x, p.y, { pinch: p.pinch ?? 0 }) }
      : { t, gesture: "None", points: null };
    events.push(...engine.update(frame).map((e) => ({ ...e, t })));
  }
  return events;
}

const types = (events) => events.map((e) => e.type);
const still = { x: 0.5, y: 0.5 };

test("the synthetic hand reads as open or pinched", () => {
  assert.ok(pinchRatio(syntheticHand(0.5, 0.5), 16 / 9) > PINCH_OFF);
  assert.ok(pinchRatio(syntheticHand(0.5, 0.5, { pinch: 1 }), 16 / 9) < PINCH_ON);
  const c = palmCenter(syntheticHand(0.3, 0.6));
  assert.ok(Math.abs(c.x - 0.3) < 0.02 && Math.abs(c.y - 0.6) < 0.03, `palm center ${JSON.stringify(c)}`);
});

test("holding an open palm still plays/pauses once", () => {
  const e = createEngine();
  const events = play(e, 0, 3000, () => still);
  assert.deepEqual(types(events), ["playpause"]);
  assert.ok(events[0].t >= HOLD_MS && events[0].t < HOLD_MS + 100, `fired at ${events[0].t}`);
});

test("the hold reports its progress", () => {
  const e = createEngine();
  play(e, 0, HOLD_MS / 2, () => still);
  assert.equal(e.state.mode, "hold");
  assert.ok(e.state.holdProgress > 0.3 && e.state.holdProgress < 0.7, `progress ${e.state.holdProgress}`);
});

test("closing the hand re-arms the hold", () => {
  const e = createEngine();
  const events = play(e, 0, 4000, (t) =>
    t < 1500 ? still : t < 2000 ? { ...still, gesture: "Closed_Fist" } : still,
  );
  assert.deepEqual(types(events), ["playpause", "playpause"]);
});

test("taking the hand away re-arms the hold too", () => {
  const e = createEngine();
  const events = play(e, 0, 4000, (t) => (t >= 1500 && t < 2000 ? null : still));
  assert.deepEqual(types(events), ["playpause", "playpause"]);
});

test("a palm that keeps moving doesn't count as a hold", () => {
  const e = createEngine();
  const events = play(e, 0, 3000, (t) => ({ x: 0.3 + 0.1 * Math.sin(t / 150), y: 0.5 }));
  assert.deepEqual(types(events), []);
});

test("other gestures don't play/pause", () => {
  const e = createEngine();
  assert.deepEqual(types(play(e, 0, 3000, () => ({ ...still, gesture: "Closed_Fist" }))), []);
});

test("swiping right is next, swiping left is previous", () => {
  const swipe = (from, to) => (t) => {
    const k = Math.min(1, Math.max(0, (t - 300) / 250));
    return { x: from + (to - from) * k, y: 0.5, gesture: "None" };
  };
  assert.deepEqual(types(play(createEngine(), 0, 1200, swipe(0.25, 0.75))), ["next"]);
  assert.deepEqual(types(play(createEngine(), 0, 1200, swipe(0.75, 0.25))), ["previous"]);
});

test("a slow drift across the frame is not a swipe", () => {
  const events = play(createEngine(), 0, 3000, (t) => ({ x: 0.2 + (0.6 * t) / 3000, y: 0.5, gesture: "None" }));
  assert.deepEqual(types(events), []);
});

test("a vertical movement is not a swipe", () => {
  const events = play(createEngine(), 0, 1000, (t) => ({ x: 0.5, y: 0.2 + Math.min(0.6, t / 400), gesture: "None" }));
  assert.deepEqual(types(events), []);
});

test("an open hand left still after a swipe doesn't also pause", () => {
  const e = createEngine();
  const events = play(e, 0, 3000, (t) => ({ x: t < 300 ? 0.25 : t < 550 ? 0.25 + ((t - 300) / 250) * 0.5 : 0.75, y: 0.5 }));
  assert.deepEqual(types(events), ["next"]);
});

test("one swipe is one command, even waved back and forth", () => {
  const e = createEngine();
  // Right then straight back left within the cooldown.
  const events = play(e, 0, 800, (t) => ({ x: t < 200 ? 0.2 + t * 0.003 : 0.8 - (t - 200) * 0.003, y: 0.5, gesture: "None" }));
  assert.deepEqual(types(events), ["next"]);
  assert.ok(COOLDOWN_MS > SWIPE_MS);
});

test("a pinch moved up raises the volume", () => {
  const e = createEngine();
  const events = play(e, 0, 1500, (t) =>
    t < 300 ? { ...still, gesture: "None" }
      : t < 1200 ? { x: 0.5, y: 0.6 - Math.min(0.3, (t - 300) / 2000), pinch: 1, gesture: "None" }
        : { x: 0.5, y: 0.3, gesture: "None" },
  );
  const kinds = types(events);
  assert.equal(kinds[0], "pinch-start");
  assert.equal(kinds.at(-1), "pinch-end");
  assert.ok(kinds.slice(1, -1).every((k) => k === "pinch-move"));
  const lastMove = events.filter((ev) => ev.type === "pinch-move").at(-1);
  assert.ok(lastMove.dy > 0.25, `moved up by ${lastMove.dy}`);
  assert.equal(volumeFromPinch(40, lastMove.dy) > 70, true);
});

test("pinching doesn't trigger play/pause or swipes", () => {
  const e = createEngine();
  const events = play(e, 0, 2000, (t) => ({ x: 0.3 + t * 0.0004, y: 0.5, pinch: 1, gesture: "Open_Palm" }));
  assert.deepEqual([...new Set(types(events))], ["pinch-start", "pinch-move"]);
  assert.equal(e.state.mode, "pinch");
});

test("a half-open pinch keeps going (hysteresis)", () => {
  const e = createEngine();
  const events = play(e, 0, 1000, (t) => ({ ...still, pinch: t < 300 ? 1 : 0.8, gesture: "None" }));
  assert.ok(!types(events).includes("pinch-end"));
});

test("losing the hand ends the pinch", () => {
  const e = createEngine();
  const events = play(e, 0, 1000, (t) => (t < 500 ? { ...still, pinch: 1, gesture: "None" } : null));
  assert.equal(types(events).at(-1), "pinch-end");
  assert.equal(e.state.mode, "none");
});

test("volumeFromPinch stays in 0..100", () => {
  assert.equal(volumeFromPinch(50, 0), 50);
  assert.equal(volumeFromPinch(50, 0.1), 65);
  assert.equal(volumeFromPinch(90, 0.5), 100);
  assert.equal(volumeFromPinch(10, -0.5), 0);
});
