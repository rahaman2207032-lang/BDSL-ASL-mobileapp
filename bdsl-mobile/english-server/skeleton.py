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


# ---------------- making generated motion continuous ----------------
# Sampled tokens (pipeline v2) sometimes land far from the previous pose, so the skeleton JUMPS between two
# frames - usually where one sign hands over to the next. We find those jumps and replace them with a short
# eased transition, then smooth gently (fingers less than arms so handshapes stay crisp).
import os
ARM_IDX = [1, 2, 3, 4, 5, 6]                                  # shoulders, elbows, wrists
JUMP_FACTOR, JUMP_MIN = 4.0, 0.22                             # jump = 4x the typical speed and > 0.22 shoulder widths/frame
BLEND = 4                                                     # frames re-drawn on each side of a jump


def _gauss(a, sigma):
    if sigma <= 0 or len(a) < 3: return a
    r = int(np.ceil(3 * sigma)); x = np.arange(-r, r + 1); w = np.exp(-0.5 * (x / sigma) ** 2); w /= w.sum()
    b = np.concatenate([a[:1].repeat(r, 0), a, a[-1:].repeat(r, 0)])
    return np.tensordot(np.stack([b[i:i + len(a)] for i in range(2 * r + 1)]), w, axes=(0, 0)).astype(a.dtype)


def find_jumps(pts):
    """frame indices t where the arms move unusually far between t and t+1"""
    if len(pts) < 4: return []
    speed = np.median(np.linalg.norm(np.diff(pts[:, ARM_IDX], axis=0), axis=2), axis=1)   # [T-1]
    thr = max(JUMP_FACTOR * float(np.median(speed)), JUMP_MIN)
    return [int(t) for t in np.where(speed > thr)[0]]


def repair_jumps(pts, blend=BLEND):
    """replace a few frames around every jump with an eased (smoothstep) transition between the poses before and after"""
    pts = pts.copy(); T = len(pts)
    for t in find_jumps(pts):
        a, b = max(0, t - blend + 1), min(T - 1, t + blend)
        if b - a < 2: continue
        u = (np.arange(a, b + 1) - a) / (b - a); u = u * u * (3 - 2 * u)                 # ease in / ease out
        pts[a:b + 1] = pts[a][None] * (1 - u)[:, None, None] + pts[b][None] * u[:, None, None]
    return pts


# ---------------- keep the arms out of the avatar's body ----------------
# The generated skeleton is a slim real person; a resting arm hangs close to the thigh with the forearm angled
# slightly inward. On the wider 3D avatar that puts the hand INSIDE / BEHIND the body. Low arm points that are
# inside the body width and not clearly in front of it are moved outward, and no arm point may go behind the back.
BODY_HALF_W = {"elbow": 0.60, "wrist": 0.66}                  # in shoulder widths from the centre line
FRONT = -0.20                                                 # z this far in front of the shoulders counts as "in front"


def keep_out_of_body(pts):
    pts = pts.copy()
    hip_y = float(np.median(pts[:, 7:9, 1])) or 1.4
    for e, w, hand in ((3, 5, slice(9, 30)), (4, 6, slice(30, 51))):
        side = 1.0 if np.median(pts[:, e - 2, 0]) >= 0 else -1.0        # which side this arm's shoulder is on
        for j, key, low_from in ((e, "elbow", 0.30), (w, "wrist", 0.55)):
            x, y, z = pts[:, j, 0], pts[:, j, 1], pts[:, j, 2]
            need = side * BODY_HALF_W[key] - x
            bad = (y > low_from * hip_y) & (side * x < BODY_HALF_W[key]) & (z > FRONT)
            dx = _gauss(np.where(bad, need, 0.0).astype(np.float32)[:, None], 2.0)[:, 0]   # eased, no popping
            dx = np.where(side * dx > 0, dx, 0.0)                         # only ever push outward
            pts[:, j, 0] += dx
            if j == w: pts[:, hand, 0] += dx[:, None]                       # the hand moves with its wrist
    arm = [3, 4, 5, 6] + list(range(9, 51))
    pts[:, arm, 2] = np.minimum(pts[:, arm, 2], 0.0)                       # never behind the back
    return pts


def orient_forward(pts):
    """Signing happens in front of the body. If the raised wrists are mostly BEHIND the shoulders, the depth
    axis came out reversed for this clip - flip it so hands are in front (z negative = towards the viewer)."""
    hip_y = float(np.median(pts[:, 7:9, 1])) or 1.4
    w = pts[:, [5, 6]]
    raised = w[..., 1] < 0.7 * hip_y
    if raised.sum() >= 5 and float(np.median(w[..., 2][raised])) > 0.05:
        pts = pts.copy(); pts[..., 2] *= -1
    return pts


def make_continuous(pts):
    if os.environ.get("BDSL_SMOOTH", "1") == "0":                 # old behaviour (3-frame average only)
        return smooth(pts)
    pts = keep_out_of_body(repair_jumps(orient_forward(pts)))
    out = pts.copy()
    out[:, :9] = _gauss(pts[:, :9], 1.6)                          # nose, shoulders, elbows, wrists, hips
    out[:, 9:] = _gauss(pts[:, 9:], 1.0)                          # 42 finger points
    for side, w in ((slice(9, 30), 5), (slice(30, 51), 6)):     # keep each hand attached to its smoothed wrist
        out[:, side] += (out[:, w] - out[:, side.start])[:, None]
    return out


def points_to_bsl(pts, fps=FPS):
    """[T, 51, 3] -> bytes in the app's .bsl format (int16, 4 shoulder widths = 32767)."""
    pts = np.asarray(pts, dtype=np.float32)
    T, N, _ = pts.shape
    q = np.clip(np.round(pts / 4.0 * 32767), -32767, 32767).astype("<i2")
    return b"BSL1" + struct.pack("<HHB", T, N, int(round(fps))) + b"\0" + q.tobytes()


def features_to_bsl(motion668, fps=FPS):
    pts = make_continuous(joints_to_points(features_to_joints(motion668)))
    return points_to_bsl(pts, fps), pts
