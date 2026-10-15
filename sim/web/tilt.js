/**
 * tilt.js — card pose for "roll the ball this way"
 *
 * The card lies flat, LED side up, display top pointing away from the viewer,
 * like a tilt maze on a table. tiltPose() leans it a little so gravity on
 * the LED face points along display direction (dx, dy) (x right, y down).
 *
 * Why this works: the accelerometer feels the "up" vector in board axes, and
 * the firmware's gravity in display axes is that vector's (x, y) (display x =
 * -board x and pull = -up, so the signs cancel; see board.h). So we want a
 * pose whose board-frame up vector is (dx*k, dy*k, up_z), and take the
 * smallest rotation from flat that gets there.
 */
import * as THREE from 'three';

export const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, Math.PI, 0));
const UP = new THREE.Vector3(0, 1, 0);
const upFlat = UP.clone().applyQuaternion(FLAT.clone().invert()); // (0, 0, ±1)

/** k = tan(tilt angle); 0.3 is ~17 degrees, ~0.29 g along the face. */
export function tiltPose(dx, dy, k = 0.3, out = new THREE.Quaternion()) {
  const want = new THREE.Vector3(dx * k, dy * k, upFlat.z).normalize();
  // q = FLAT * r with r^-1 * upFlat = want  =>  r maps want onto upFlat
  const r = new THREE.Quaternion().setFromUnitVectors(want, upFlat);
  return out.copy(FLAT).multiply(r);
}
