"""
tracking.py - finds the 543 body points EXACTLY like your sign_live.py does (classic MediaPipe Holistic,
mediapipe==0.10.14, model_complexity=1, refine_face_landmarks=False, confidence 0.5, frames not mirrored).
The phone/PC app sends the camera frames of one sign (small JPEGs); we return [T, 543, 3] with NaN = missing,
the same input your ASL model gets on your friend's PC.
"""
import threading

import numpy as np

N_LANDMARKS = 543
FACE, LH, POSE, RH = slice(0, 468), slice(468, 489), slice(489, 522), slice(522, 543)
PREROLL = 4                      # like sign_live.py auto mode: keep 4 frames before the hands appear
_LOCK = threading.Lock()


def available():
    """'' if ready, otherwise why not."""
    try:
        import cv2  # noqa: F401
        import mediapipe as mp
    except Exception as e:
        return f"mediapipe not installed ({e})"
    if not hasattr(mp, "solutions"):
        return f"mediapipe {mp.__version__} is too new (needs 0.10.14)"
    return ""


def frames_to_543(jpegs, complexity=1):
    """list of JPEG bytes (one sign) -> [T, 543, 3] float32, trimmed like sign_live.py (preroll 4, no empty tail)."""
    import cv2
    import mediapipe as mp

    rows, hands = [], []
    with _LOCK:                  # one sign at a time; a fresh Holistic per sign = tracking starts clean
        with mp.solutions.holistic.Holistic(static_image_mode=False, model_complexity=complexity,
                                            refine_face_landmarks=False,
                                            min_detection_confidence=0.5, min_tracking_confidence=0.5) as hol:
            for jb in jpegs:
                bgr = cv2.imdecode(np.frombuffer(jb, np.uint8), cv2.IMREAD_COLOR)
                if bgr is None:
                    continue
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                res = hol.process(rgb)
                lm = np.full((N_LANDMARKS, 3), np.nan, dtype=np.float32)
                for part, sl in ((res.face_landmarks, FACE), (res.left_hand_landmarks, LH),
                                 (res.pose_landmarks, POSE), (res.right_hand_landmarks, RH)):
                    if part is not None:
                        pts = np.array([[p.x, p.y, p.z] for p in part.landmark], dtype=np.float32)
                        lm[sl] = pts[: sl.stop - sl.start]
                rows.append(lm)
                hands.append(res.left_hand_landmarks is not None or res.right_hand_landmarks is not None)
    if not rows:
        raise ValueError("no readable frames")
    hands = np.array(hands)
    if not hands.any():
        raise ValueError("No hands were seen - keep both hands inside the picture")
    a = max(0, int(np.argmax(hands)) - PREROLL)
    b = len(hands) - int(np.argmax(hands[::-1]))          # last frame with a hand (exclusive end)
    return np.stack(rows[a:b]), int(hands.sum())
