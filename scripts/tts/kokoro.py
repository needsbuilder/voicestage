#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = ["kokoro-onnx>=0.6.1,<0.7"]
# ///
"""Render one sentence to a WAV file with Kokoro, a neural voice that runs on this computer.

Written for `voicestage record`, as the program behind `recording.voices.command`:

    recording:
      voices:
        name: kokoro
        command: uv run -q scripts/tts/kokoro.py --voice {voice} --rate {rate} --lang {lang} --text-file {text_file} --out {out}

By hand:

    uv run scripts/tts/kokoro.py --voice af_bella --out line.wav --text "Nothing has been paid."
    uv run scripts/tts/kokoro.py --list

`uv` (https://docs.astral.sh/uv/) reads the block at the top of this file and
fetches Python 3.12 and the kokoro-onnx package the first time. Nothing else
is installed.

The two model files are not in this repository (about 340 MB together). Get
them from the kokoro-onnx project:

    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

and say where they are: set KOKORO_DIR to the folder that holds both, or pass
--model and --voices (or set KOKORO_MODEL and KOKORO_VOICES).

A voice name starts with its accent: af_ and am_ are American, bf_ and bm_
British. Without --lang the sentence is read with the accent of the voice.
The voices of other languages need --lang (for example fr-fr); only the
English ones were tried here.

Output: 24 kHz, mono, 16-bit.

Kokoro's weights are published under Apache-2.0 (hexgrad/Kokoro-82M) and
kokoro-onnx under MIT. This script is not part of either project.
"""
import argparse
import os
import sys
import wave
from typing import NoReturn

MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
ENGLISH = {"a": "en-us", "b": "en-gb"}


def stop(message: str) -> NoReturn:
    print(f"kokoro.py: {message}", file=sys.stderr)
    sys.exit(2)


def model_paths(args: argparse.Namespace) -> tuple[str, str]:
    folder = os.environ.get("KOKORO_DIR")
    model = args.model or os.environ.get("KOKORO_MODEL") or (os.path.join(folder, MODEL_FILE) if folder else None)
    voices = args.voices or os.environ.get("KOKORO_VOICES") or (os.path.join(folder, VOICES_FILE) if folder else None)
    where = f"Download {RELEASE}/{MODEL_FILE} and {RELEASE}/{VOICES_FILE}, then set KOKORO_DIR to the folder they are in."
    if not model or not voices:
        stop(f"the Kokoro model files have not been located. {where}")
    for path in (model, voices):
        if not os.path.isfile(path):
            stop(f"there is no file at {path}. {where}")
    return model, voices


def main() -> None:
    parser = argparse.ArgumentParser(description="Render one sentence to a WAV file with Kokoro.")
    parser.add_argument("--text", help="the sentence")
    parser.add_argument("--text-file", help="a UTF-8 file that holds the sentence (instead of --text)")
    parser.add_argument("--voice", help="a Kokoro voice name, for example af_bella")
    parser.add_argument("--rate", type=float, default=1.0, help="speaking rate, 0.5 to 2 (default 1)")
    parser.add_argument("--lang", default="", help="for example en-us or en-gb (default: the accent of the voice)")
    parser.add_argument("--out", help="where to write the WAV file")
    parser.add_argument("--model", help=f"path of {MODEL_FILE} (or KOKORO_MODEL, or KOKORO_DIR)")
    parser.add_argument("--voices", help=f"path of {VOICES_FILE} (or KOKORO_VOICES, or KOKORO_DIR)")
    parser.add_argument("--list", action="store_true", help="print the voice names and stop")
    args = parser.parse_args()

    model, voices = model_paths(args)
    # Imported here, so that a missing file is reported without loading the runtime first.
    import numpy as np
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(model, voices)
    names = sorted(kokoro.get_voices())
    if args.list:
        print("\n".join(names))
        return

    if not args.voice:
        stop("give --voice. See --list for the names.")
    if args.voice not in names:
        stop(f'Kokoro has no voice named "{args.voice}". It has: {", ".join(names)}')
    if not args.out:
        stop("give --out, the WAV file to write.")
    if args.text is not None:
        text = args.text
    elif args.text_file:
        with open(args.text_file, encoding="utf-8") as source:
            text = source.read()
    else:
        text = sys.stdin.read()
    text = text.strip()
    if not text:
        stop("there is nothing to say: the text is empty.")
    if not 0.5 <= args.rate <= 2:
        stop(f"--rate must be between 0.5 and 2, got {args.rate}.")
    lang = args.lang.strip().lower().replace("_", "-") or ENGLISH.get(args.voice[0])
    if not lang:
        stop(f'give --lang for the voice "{args.voice}": only the English voices (af_, am_, bf_, bm_) have a default.')

    samples, rate = kokoro.create(text, voice=args.voice, speed=args.rate, lang=lang)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    if pcm.size == 0:
        stop(f'Kokoro returned no audio for "{text}".')
    with wave.open(args.out, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main()
