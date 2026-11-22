import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  stepFlySpeed,
  clampSpeed,
  moveFactor,
  turnFactor,
  easeToward,
  easedDistance,
  turnForward,
  pitchOf,
  worldDisplacement,
  lookRadiansPerPixel,
  exitAnchorDistance,
  DEFAULT_FLY_SPEED,
  MIN_FLY_SPEED,
  MAX_FLY_SPEED,
  PITCH_MARGIN,
  EASE_TAU,
  EXIT_ANCHOR_FALLBACK,
} from '../src/viewer/flyMath';

const UP = new THREE.Vector3(0, 1, 0);
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('fly speed steps', () => {
  it('starts at 5 m/s, within 0.5 to 50 m/s', () => {
    expect(DEFAULT_FLY_SPEED).toBe(5);
    expect(MIN_FLY_SPEED).toBe(0.5);
    expect(MAX_FLY_SPEED).toBe(50);
  });

  it('steps 1 m/s at a time from 1 m/s upwards', () => {
    expect(stepFlySpeed(5, 1)).toBe(6);
    expect(stepFlySpeed(5, -1)).toBe(4);
    expect(stepFlySpeed(1, 1)).toBe(2);
    expect(stepFlySpeed(2, -1)).toBe(1);
  });

  it('steps 0.25 m/s at a time below 1 m/s', () => {
    expect(stepFlySpeed(1, -1)).toBe(0.75);
    expect(stepFlySpeed(0.75, -1)).toBe(0.5);
    expect(stepFlySpeed(0.5, 1)).toBe(0.75);
    expect(stepFlySpeed(0.75, 1)).toBe(1);
  });

  it('visits only tidy values all the way up and back down', () => {
    const up: number[] = [];
    let s = MIN_FLY_SPEED;
    while (s < MAX_FLY_SPEED) {
      s = stepFlySpeed(s, 1);
      up.push(s);
    }
    expect(up.slice(0, 4)).toEqual([0.75, 1, 2, 3]);
    expect(up[up.length - 1]).toBe(50);
    const down: number[] = [];
    while (s > MIN_FLY_SPEED) {
      s = stepFlySpeed(s, -1);
      down.push(s);
    }
    expect(down.reverse().slice(1)).toEqual([MIN_FLY_SPEED, ...up].slice(1, -1));
  });

  it('clamps at both ends', () => {
    expect(stepFlySpeed(MAX_FLY_SPEED, 1)).toBe(MAX_FLY_SPEED);
    expect(stepFlySpeed(MIN_FLY_SPEED, -1)).toBe(MIN_FLY_SPEED);
    expect(clampSpeed(1000)).toBe(MAX_FLY_SPEED);
    expect(clampSpeed(0)).toBe(MIN_FLY_SPEED);
  });

  it('snaps an off-grid speed onto the grid in the direction asked', () => {
    expect(stepFlySpeed(4.4, 1)).toBe(5);
    expect(stepFlySpeed(4.4, -1)).toBe(4);
    expect(stepFlySpeed(0.6, 1)).toBe(0.75);
    expect(stepFlySpeed(0.6, -1)).toBe(0.5);
  });
});

describe('modifiers', () => {
  it('Shift boosts movement 4×, Space slows it to a quarter', () => {
    expect(moveFactor({ boost: false, precise: false })).toBe(1);
    expect(moveFactor({ boost: true, precise: false })).toBe(4);
    expect(moveFactor({ boost: false, precise: true })).toBe(0.25);
  });

  it('Space slows turning, Shift does not speed it up', () => {
    expect(turnFactor({ precise: false })).toBe(1);
    expect(turnFactor({ precise: true })).toBe(0.25);
  });
});

describe('easeToward', () => {
  it('is 95 % of the way after three time constants', () => {
    expect(easeToward(0, 1, 3 * EASE_TAU)).toBeCloseTo(0.95, 2);
  });

  it('eases in and out in about 120 ms', () => {
    expect(easeToward(0, 10, 0.12)).toBeGreaterThan(9.4);
    expect(easeToward(10, 0, 0.12)).toBeLessThan(0.6);
  });

  it('is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 4; i++) a = easeToward(a, 1, 0.025);
    const b = easeToward(0, 1, 0.1);
    expect(a).toBeCloseTo(b, 12);
  });

  it('does nothing for a zero or negative step', () => {
    expect(easeToward(3, 7, 0)).toBe(3);
    expect(easeToward(3, 7, -1)).toBe(3);
  });
});

describe('easedDistance', () => {
  it('is cruise speed times time once at speed', () => {
    expect(easedDistance(5, 5, 2)).toBeCloseTo(10, 12);
  });

  it('is the same however the time is cut into frames', () => {
    let v = 0;
    let d = 0;
    for (let i = 0; i < 7; i++) {
      d += easedDistance(v, 5, 0.3 / 7);
      v = easeToward(v, 5, 0.3 / 7);
    }
    expect(d).toBeCloseTo(easedDistance(0, 5, 0.3), 12);
  });

  it('coasts a short way after letting go', () => {
    // From 5 m/s to rest the coast is v·τ: 20 cm.
    expect(easedDistance(5, 0, 10)).toBeCloseTo(5 * EASE_TAU, 6);
  });
});

describe('turnForward', () => {
  it('yaws about the up axis, positive to the left', () => {
    const out = turnForward(v(0, 0, -1), UP, Math.PI / 2, 0, new THREE.Vector3());
    expect(out.distanceTo(v(-1, 0, 0))).toBeCloseTo(0, 10);
  });

  it('keeps the pitch while yawing', () => {
    const f = v(0, 0.5, -1).normalize();
    const out = turnForward(f, UP, 1.3, 0, new THREE.Vector3());
    expect(pitchOf(out, UP)).toBeCloseTo(pitchOf(f, UP), 10);
    expect(out.length()).toBeCloseTo(1, 10);
  });

  it('pitches up and down', () => {
    const out = turnForward(v(0, 0, -1), UP, 0, 0.3, new THREE.Vector3());
    expect(pitchOf(out, UP)).toBeCloseTo(0.3, 10);
  });

  it('clamps pitch just short of straight up and down', () => {
    const limit = Math.PI / 2 - PITCH_MARGIN;
    const up = turnForward(v(0, 0, -1), UP, 0, 10, new THREE.Vector3());
    expect(pitchOf(up, UP)).toBeCloseTo(limit, 10);
    const down = turnForward(v(0, 0, -1), UP, 0, -10, new THREE.Vector3());
    expect(pitchOf(down, UP)).toBeCloseTo(-limit, 10);
    // Still has a heading, so the view cannot flip over.
    expect(Math.hypot(up.x, up.z)).toBeGreaterThan(0.01);
  });

  it('finds a heading when started looking straight down', () => {
    const out = turnForward(v(0, -1, 0), UP, 0, 0, new THREE.Vector3());
    expect(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)).toBe(true);
    expect(pitchOf(out, UP)).toBeCloseTo(-(Math.PI / 2 - PITCH_MARGIN), 10);
  });

  it('may write into its input', () => {
    const f = v(0, 0, -1);
    const same = turnForward(f, UP, Math.PI, 0, f);
    expect(same).toBe(f);
    expect(f.distanceTo(v(0, 0, 1))).toBeCloseTo(0, 10);
  });
});

describe('worldDisplacement', () => {
  const tilted = v(0, -1, -1).normalize(); // looking forward and down 45°

  it('moves forward along the view direction, tilt included', () => {
    const d = worldDisplacement(tilted, UP, { forward: 2, right: 0, up: 0 }, new THREE.Vector3());
    expect(d.distanceTo(tilted.clone().multiplyScalar(2))).toBeCloseTo(0, 10);
  });

  it('strafes horizontally whatever the tilt', () => {
    const d = worldDisplacement(tilted, UP, { forward: 0, right: 3, up: 0 }, new THREE.Vector3());
    expect(d.distanceTo(v(3, 0, 0))).toBeCloseTo(0, 10);
  });

  it('rises straight up the model whatever the tilt', () => {
    const d = worldDisplacement(tilted, UP, { forward: 0, right: 0, up: 1.5 }, new THREE.Vector3());
    expect(d.distanceTo(v(0, 1.5, 0))).toBeCloseTo(0, 10);
  });

  it('combines directions', () => {
    const d = worldDisplacement(v(0, 0, -1), UP, { forward: 1, right: -1, up: 1 }, new THREE.Vector3());
    expect(d.distanceTo(v(-1, 1, -1))).toBeCloseTo(0, 10);
  });
});

describe('lookRadiansPerPixel', () => {
  it('turns half a turn over the height of the view', () => {
    expect(lookRadiansPerPixel(800) * 800).toBeCloseTo(Math.PI, 10);
  });

  it('survives a zero-height view', () => {
    expect(Number.isFinite(lookRadiansPerPixel(0))).toBe(true);
  });
});

describe('exitAnchorDistance', () => {
  it('uses what is straight ahead', () => {
    expect(exitAnchorDistance(7.5)).toBe(7.5);
  });

  it('falls back to a few metres over empty space', () => {
    expect(exitAnchorDistance(null)).toBe(EXIT_ANCHOR_FALLBACK);
    expect(exitAnchorDistance(0)).toBe(EXIT_ANCHOR_FALLBACK);
    expect(exitAnchorDistance(Number.NaN)).toBe(EXIT_ANCHOR_FALLBACK);
  });

  it('keeps the anchor off the camera', () => {
    expect(exitAnchorDistance(1e-6)).toBeGreaterThan(0.01);
  });
});
