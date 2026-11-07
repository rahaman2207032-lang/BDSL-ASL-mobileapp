"""
app.py - the English engine as a FREE Hugging Face Space (Gradio SDK, ZeroGPU hardware).
Started the standard Gradio way (demo.launch), which is what ZeroGPU Spaces expect.
The phone app calls three Gradio API functions:  health, text2sign, sign2word
(each returns a JSON string), and there is a small test page for you on the Space.
The models run on the CPU, so no GPU time is used.
"""
import os
os.environ.setdefault("GRADIO_SSR_MODE", "False")
try:                     # ZeroGPU Spaces: "spaces" must be imported before torch
    import spaces
except ImportError:      # on your PC
    spaces = None
import base64
import json
import threading

import gradio as gr

import server            # re-uses the model loading and the two functions from server.py
import skeleton

threading.Thread(target=server.load_engines, args=("cpu",), daemon=True).start()


def _safe(fn, *args):
    try:
        return json.dumps(fn(*args), ensure_ascii=False)
    except Exception as e:
        import traceback; traceback.print_exc()
        return json.dumps({"error": str(e)})


def api_health():
    return json.dumps({"ok": True, "text2sign": server.STATE["text2sign"], "sign2word": server.STATE["sign2word"],
                       "fps": skeleton.FPS, "version": 1})


def api_text2sign(text):
    text = str(text or "").strip()[:300]
    if not text:
        return json.dumps({"error": "empty text"})
    return _safe(server.text2sign, text)


def api_sign2word(b64, frames):
    try:
        raw = base64.b64decode(b64 or "")
    except Exception:
        return json.dumps({"error": "bad data"})
    return _safe(server.sign2word, raw, int(frames or 0))


if spaces is not None:   # ZeroGPU needs at least one GPU function; the models themselves run on the CPU
    @spaces.GPU(duration=5)
    def _gpu_check():
        return 0


def demo_fn(text):
    j = json.loads(api_text2sign(text))
    if "error" in j:
        return "Error: " + j["error"]
    return f"Gloss: {j['gloss']}\nFrames: {j['frames']} at {j['fps']} fps\nTime: {j['ms']} ms"


with gr.Blocks(title="BdSL English Engine") as demo:
    gr.Markdown("## BdSL app - English engine\nThe phone app uses this Space. Test English text -> sign here:")
    status = gr.Textbox(label="Status", interactive=False)
    gr.Button("Refresh status").click(lambda: api_health(), None, status, api_name=False)
    inp = gr.Textbox(label="English sentence", value="Where are you going?")
    out = gr.Textbox(label="Result", interactive=False)
    gr.Button("Generate").click(demo_fn, inp, out, api_name=False)
    demo.load(lambda: api_health(), None, status, api_name=False)

    with gr.Row(visible=False):                     # API used by the phone app
        t_in, t_out = gr.Textbox(), gr.Textbox()
        s_b64, s_n, s_out, h_out = gr.Textbox(), gr.Number(), gr.Textbox(), gr.Textbox()
        gr.Button().click(api_health, None, h_out, api_name="health", concurrency_limit=8)
        gr.Button().click(api_text2sign, t_in, t_out, api_name="text2sign")
        gr.Button().click(api_sign2word, [s_b64, s_n], s_out, api_name="sign2word", concurrency_limit=4)

demo.queue(max_size=40)

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860, ssr_mode=False)
