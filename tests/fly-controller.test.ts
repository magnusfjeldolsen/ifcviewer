import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FlyController } from '../src/viewer/FlyController';
import { pitchOf } from '../src/viewer/flyMath';

const UP = new THREE.Vector3(0, 1, 0);

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1); // facing -Z
  cam.updateMatrixWorld();
  return cam;
}

/** Run `seconds` of frames at `fps`. */
function run(fly: FlyController, cam: THREE.PerspectiveCamera, seconds: number, fps = 60): void {
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) fly.tick(cam, 1 / fps);
}

const forwardOf = (cam: THREE.PerspectiveCamera): THREE.Vector3 => cam.getWorldDirection(new THREE.Vector3());
const yawOf = (cam: THREE.PerspectiveCamera): number => {
  const f = forwardOf(cam);
  return Math.atan2(-f.x, -f.z);
};

describe('FlyController — moving', () => {
  it('covers the cruising speed in metres per second', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('KeyW');
    run(fly, cam, 1);
    run(fly, cam, 2);
    const at3 = cam.position.z;
    run(fly, cam, 1);
    // A full second at cruise covers 5 m.
    expect(at3 - cam.position.z).toBeCloseTo(5, 3);
  });

  it('moves the same distance at 30 and 144 fps', () => {
    const a = new FlyController();
    const b = new FlyController();
    const ca = camera();
    const cb = camera();
    a.keyDown('KeyW');
    b.keyDown('KeyW');
    run(a, ca, 2, 30);
    run(b, cb, 2, 144);
    expect(ca.position.z).toBeCloseTo(cb.position.z, 6);
  });

  it('eases in and out instead of starting and stopping dead', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('KeyD');
    fly.tick(cam, 1 / 60);
    const firstFrame = cam.position.x;
    // Full speed would be 5/60 m in one frame; the ease starts well below it.
    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(5 / 60 / 2);
    run(fly, cam, 0.5);
    fly.keyUp('KeyD');
    const released = cam.position.x;
    fly.tick(cam, 1 / 60);
    expect(cam.position.x).toBeGreaterThan(released); // still coasting
    run(fly, cam, 1);
    expect(fly.isMoving()).toBe(false);
    // The coast is short: a fraction of a metre at 5 m/s.
    expect(cam.position.x - released).toBeLessThan(0.3);
  });

  it('E and Q move straight up and down even when looking down', () => {
    const fly = new FlyController();
    const cam = camera();
    cam.lookAt(0, -1, -1);
    cam.updateMatrixWorld();
    fly.keyDown('KeyE');
    run(fly, cam, 1);
    expect(cam.position.x).toBeCloseTo(0, 10);
    expect(cam.position.z).toBeCloseTo(0, 10);
    expect(cam.position.y).toBeGreaterThan(3);
  });

  it('Shift boosts 4×, Space slows to a quarter', () => {
    const measure = (mod: string | null): number => {
      const fly = new FlyController();
      const cam = camera();
      if (mod) fly.keyDown(mod);
      fly.keyDown('KeyW');
      run(fly, cam, 2);
      return -cam.position.z;
    };
    const plain = measure(null);
    expect(measure('ShiftLeft') / plain).toBeCloseTo(4, 1);
    expect(measure('Space') / plain).toBeCloseTo(0.25, 1);
  });

  it('modifiers alone do not move or keep frames coming', () => {
    const fly = new FlyController();
    fly.keyDown('ShiftLeft');
    fly.keyDown('Space');
    expect(fly.isMoving()).toBe(false);
  });

  it('ignores keys that are not fly keys', () => {
    const fly = new FlyController();
    expect(fly.keyDown('KeyM')).toBe(false);
    expect(fly.keyDown('KeyC')).toBe(false);
    expect(fly.isMoving()).toBe(false);
  });

  it('caps a long stalled frame instead of flinging the camera', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('KeyW');
    run(fly, cam, 1);
    const before = cam.position.z;
    fly.tick(cam, 5);
    expect(before - cam.position.z).toBeLessThan(1);
  });
});

describe('FlyController — turning', () => {
  it('arrow keys turn about 90° per second, Left to the left', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('ArrowLeft');
    run(fly, cam, 1);
    fly.keyUp('ArrowLeft');
    run(fly, cam, 1);
    // Ease in and out cancel: the turn is the rate times the time held.
    expect(yawOf(cam)).toBeCloseTo(Math.PI / 2, 1);
    expect(cam.position.length()).toBe(0); // turning does not move
  });

  it('Right turns the other way', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('ArrowRight');
    run(fly, cam, 0.5);
    expect(yawOf(cam)).toBeLessThan(0);
  });

  it('Up and Down look up and down, clamped short of the pole', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('ArrowUp');
    run(fly, cam, 5);
    const pitch = pitchOf(forwardOf(cam), UP);
    expect(pitch).toBeGreaterThan(1.5);
    expect(pitch).toBeLessThan(Math.PI / 2);
    fly.keyUp('ArrowUp');
    fly.keyDown('ArrowDown');
    run(fly, cam, 10);
    expect(pitchOf(forwardOf(cam), UP)).toBeLessThan(-1.5);
  });

  it('never rolls the camera', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('ArrowUp');
    fly.keyDown('ArrowLeft');
    run(fly, cam, 0.7);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    expect(right.y).toBeCloseTo(0, 10);
  });

  it('Space slows turning, Shift does not speed it up', () => {
    const turned = (mod: string | null): number => {
      const fly = new FlyController();
      const cam = camera();
      if (mod) fly.keyDown(mod);
      fly.keyDown('ArrowLeft');
      run(fly, cam, 0.5);
      return yawOf(cam);
    };
    const plain = turned(null);
    expect(turned('ShiftLeft')).toBeCloseTo(plain, 10);
    expect(turned('Space') / plain).toBeCloseTo(0.25, 2);
  });

  it('mouse look: drag right turns right, drag up looks up', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.look(cam, 100, 0, 800);
    expect(yawOf(cam)).toBeCloseTo(-Math.PI / 8, 6);
    fly.look(cam, 0, -100, 800);
    expect(pitchOf(forwardOf(cam), UP)).toBeCloseTo(Math.PI / 8, 6);
  });
});

describe('FlyController — speed', () => {
  it('X steps faster and Z slower, once per press', () => {
    const fly = new FlyController();
    fly.keyDown('KeyX');
    expect(fly.getSpeed()).toBe(6);
    fly.keyDown('KeyX', true); // auto-repeat
    expect(fly.getSpeed()).toBe(6);
    fly.keyDown('KeyZ');
    fly.keyDown('KeyZ');
    expect(fly.getSpeed()).toBe(4);
  });

  it('tells listeners when the speed changes, and only then', () => {
    const fly = new FlyController();
    const heard: number[] = [];
    fly.onSpeedChange((s) => heard.push(s));
    fly.stepSpeed(1);
    fly.setSpeed(50);
    fly.stepSpeed(1); // already at the top
    expect(heard).toEqual([6, 50]);
  });
});

describe('FlyController — letting go', () => {
  it('releaseAll lets go of every held key', () => {
    const fly = new FlyController();
    fly.keyDown('KeyW');
    fly.keyDown('ShiftLeft');
    fly.keyDown('ArrowLeft');
    fly.releaseAll();
    expect(fly.isHeld('KeyW')).toBe(false);
    expect(fly.isHeld('ShiftLeft')).toBe(false);
    expect(fly.isHeld('ArrowLeft')).toBe(false);
  });

  it('stop drops motion at once, with no coast', () => {
    const fly = new FlyController();
    const cam = camera();
    fly.keyDown('KeyW');
    run(fly, cam, 1);
    fly.stop();
    expect(fly.isMoving()).toBe(false);
    const z = cam.position.z;
    expect(fly.tick(cam, 1 / 60)).toBe(false);
    expect(cam.position.z).toBe(z);
  });
});
