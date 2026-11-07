"""
skeleton.py - turns Motion-S output [T, 668] into the app's avatar format (.bsl, 51 points per frame).

668-D layout (same as the official Kiseki visualizer that drew generated_motion_3d.mp4):
    [0:4]      root: rotation velocity, XZ velocity, height
    [4:334]    55 x 6D joint rotations          (not needed for drawing)
    [334:499]  55 x 3  joint positions relative to the root (RIC)
    [499:664]  55 x 3  joint velocities
    [664:668]  foot contacts
Skeleton = the 55-joint SMPL-X BVH used by Motion-S (names below). Recordings are 24 fps.

App format (.bsl, same as the Bangla pack): 51 points
    0 nose | 1 L shoulder | 2 R shoulder | 3 L elbow | 4 R elbow | 5 L wrist | 6 R wrist | 7 L hip | 8 R hip
    9..29 left hand (21 MediaPipe points) | 30..50 right hand
    x right, y down, z away from the camera, centred on the neck, 1 unit = one shoulder width.
"""
import struct
import numpy as np

FPS = 24
JOINTS = ['pelvis', 'left_hip', 'left_knee', 'left_ankle', 'left_foot', 'right_hip', 'right_knee', 'right_ankle', 'right_foot',
          'spine1', 'spine2', 'spine3', 'neck', 'head', 'jaw', 'left_eye_smplhf', 'right_eye_smplhf', 'left_collar',
          'left_shoulder', 'left_elbow', 'left_wrist', 'left_index1', 'left_index2', 'left_index3', 'left_middle1',
          'left_middle2', 'left_middle3', 'left_pinky1', 'left_pinky2', 'left_pinky3', 'left_ring1', 'left_ring2', 'left_ring3',
          'left_thumb1', 'left_thumb2', 'left_thumb3', 'right_collar', 'right_shoulder', 'right_elbow', 'right_wrist',
          'right_index1', 'right_index2', 'right_index3', 'right_middle1', 'right_middle2', 'right_middle3', 'right_pinky1',
          'right_pinky2', 'right_pinky3', 'right_ring1', 'right_ring2', 'right_ring3', 'right_thumb1', 'right_thumb2', 'right_thumb3']
J = {n: i for i, n in enumerate(JOINTS)}
NJ = len(JOINTS)


# ---------------- Kiseki reconstruction (quaternions as [w, x, y, z]) ----------------
def _qinv(q):
    r = q.copy(); r[..., 1:] = -r[..., 1:]; return r


def _qrot(q, v):
    shape = v.shape
    q = q.reshape(-1, 4); v = v.reshape(-1, 3)
    uv = np.cross(q[:, 1:], v); uuv = np.cross(q[:, 1:], uv)
    return (v + 2 * (q[:, :1] * uv + uuv)).reshape(shape)


def features_to_joints(f):
    """[T, 668] -> [T, 55, 3] world positions (y up)."""
    f = np.asarray(f, dtype=np.float64)
    T = f.shape[0]
    ang = np.zeros((T, 1)); ang[1:] = f[:-1, 0:1]; ang = np.cumsum(ang / 2, axis=0)
    rq = np.zeros((T, 4)); rq[:, 0] = np.cos(ang[:, 0]); rq[:, 2] = np.sin(ang[:, 0])
    rp = np.zeros((T, 3)); rp[1:, [0, 2]] = f[:-1, 1:3]
    rp = np.cumsum(_qrot(_qinv(rq), rp), axis=0); rp[:, 1] = f[:, 3]
    s = 4 + NJ * 6
    ric = f[:, s:s + NJ * 3].reshape(T, NJ, 3)
    pos = _qrot(_qinv(np.repeat(rq[:, None], NJ, 1)), ric)
    pos[:, :, 0] += rp[:, 0:1]; pos[:, :, 2] += rp[:, 2:3]
    return pos


# ---------------- 55 SMPL-X joints -> 51 app points ----------------
def _hand(P, side):
    """21 MediaPipe hand points from SMPL-X wrist + 3 joints per finger (tip = last joint + 75% of the last bone)."""
    g = lambda n: P[:, J[f"{side}_{n}"]]
    out = [g("wrist")]
    for finger in ("thumb", "index", "middle", "ring", "pinky"):
        a, b, c = g(finger + "1"), g(finger + "2"), g(finger + "3")
        out += [a, b, c, c + 0.75 * (c - b)]
    return np.stack(out, 1)                                   # [T, 21, 3]


def joints_to_points(P):
    """[T, 55, 3] (y up) -> [T, 51, 3] in the app's camera frame (person faces the camera)."""
    P = np.asarray(P, dtype=np.float64)
    ls, rs = P[:, J["left_shoulder"]], P[:, J["right_shoulder"]]
    neck = (ls + rs) / 2
    up = np.array([0.0, 1.0, 0.0])
    across = (ls - rs).mean(0); across[1] = 0
    across /= (np.linalg.norm(across) or 1.0)                  # towards the person's LEFT (= right side of the picture)
    facing = np.cross(across, up); facing /= (np.linalg.norm(facing) or 1.0)
    sw = float(np.median(np.linalg.norm(ls - rs, axis=1))) or 1.0

    head = P[:, J["head"]]
    nose = head + facing * 0.30 * sw + up * 0.05 * sw          # nose sits in front of the head joint
    pts = np.concatenate([
        nose[:, None], ls[:, None], rs[:, None],
        P[:, [J["left_elbow"], J["right_elbow"], J["left_wrist"], J["right_wrist"], J["left_hip"], J["right_hip"]]],
        _hand(P, "left"), _hand(P, "right")], axis=1)          # [T, 51, 3]

    rel = pts - neck[:, None]
    x = rel @ across                                           # person's left -> +x (picture right), like MediaPipe
    y = -(rel @ up)                                            # picture y grows downwards
    z = -(rel @ facing)                                        # MediaPipe: smaller z = closer to the camera
    return (np.stack([x, y, z], -1) / sw).astype(np.float32)


def smooth(a, k=3):
    if len(a) < k: return a
    pad = k // 2
    b = np.concatenate([a[:1].repeat(pad, 0), a, a[-1:].repeat(pad, 0)])
    c = np.cumsum(b, 0); c = np.concatenate([np.zeros_like(c[:1]), c])
    return ((c[k:] - c[:-k]) / k).astype(a.dtype)


def points_to_bsl(pts, fps=FPS):
    """[T, 51, 3] -> bytes in the app's .bsl format (int16, 4 shoulder widths = 32767)."""
    pts = np.asarray(pts, dtype=np.float32)
    T, N, _ = pts.shape
    q = np.clip(np.round(pts / 4.0 * 32767), -32767, 32767).astype("<i2")
    return b"BSL1" + struct.pack("<HHB", T, N, int(round(fps))) + b"\0" + q.tobytes()


def features_to_bsl(motion668, fps=FPS):
    pts = smooth(joints_to_points(features_to_joints(motion668)))
    return points_to_bsl(pts, fps), pts
