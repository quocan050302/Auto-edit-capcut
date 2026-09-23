# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "faster-whisper>=1.0.0",
# ]
# ///
"""
Transcription script — run via: uv run scripts/transcribe.py <args>
Outputs JSON to stdout, all warnings/logs to stderr.
"""
import sys
import json
import argparse
import os
import warnings

# Suppress HuggingFace Hub warnings before any imports
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_LOCAL_DIR_USE_SYMLINKS"] = "false"   # disable symlinks on Windows
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
warnings.filterwarnings("ignore")

def emit(obj: dict):
    """Write JSON line to stdout and flush immediately."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def progress(message: str, pct: float):
    emit({"type": "progress", "message": message, "progress": pct})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="Path to audio file")
    parser.add_argument("--model", default="base",
                        choices=["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "large-v2", "large-v3"])
    parser.add_argument("--language", default=None)
    parser.add_argument("--cache-dir", default=None)
    args = parser.parse_args()

    progress("Importing faster-whisper...", 0.03)

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        emit({"type": "error", "message": f"Import failed: {e}"})
        sys.exit(1)

    model_dir = args.cache_dir or os.path.join(
        os.path.expanduser("~"), ".cache", "whisper-models"
    )
    os.makedirs(model_dir, exist_ok=True)

    progress(f"Loading model '{args.model}' (first run downloads ~150MB)...", 0.08)

    try:
        # Redirect stderr during model loading to hide noisy HF Hub output
        import io
        import contextlib

        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=model_dir,
            local_files_only=False,
        )
    except Exception as e:
        err = str(e)
        # Retry with local_files_only=False and explicit fallback
        progress(f"Model load error: {err[:80]} — retrying...", 0.12)
        try:
            from faster_whisper import WhisperModel as WM
            model = WM(args.model, device="cpu", compute_type="int8",
                       download_root=model_dir)
        except Exception as e2:
            emit({"type": "error", "message": f"Cannot load model: {e2}"})
            sys.exit(1)

    progress("Model loaded. Starting transcription...", 0.20)

    try:
        segments_iter, info = model.transcribe(
            args.audio,
            language=args.language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
        )
    except Exception as e:
        emit({"type": "error", "message": f"Transcription error: {e}"})
        sys.exit(1)

    lang = getattr(info, "language", "unknown")
    prob = round(getattr(info, "language_probability", 0), 3)
    dur  = round(getattr(info, "duration", 0), 2)

    progress(f"Language: {lang} ({prob:.0%}). Processing segments...", 0.25)

    segments = []
    i = 0
    for seg in segments_iter:
        i += 1
        pct = min(0.25 + (i / max(1, 500)) * 0.70, 0.95)
        progress(f"[{i}] {seg.text.strip()[:60]}", pct)

        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "word":  w.word,
                    "start": round(w.start, 3),
                    "end":   round(w.end, 3)
                })

        segments.append({
            "id":       f"N{i:03d}",
            "text":     seg.text.strip(),
            "start":    round(seg.start, 3),
            "end":      round(seg.end, 3),
            "duration": round(seg.end - seg.start, 3),
            "words":    words
        })

    full_text  = " ".join(s["text"] for s in segments)
    word_count = len(full_text.split())

    progress(f"Done — {len(segments)} segments, {word_count} words", 1.0)

    emit({
        "type":                "result",
        "language":            lang,
        "languageProbability": prob,
        "duration":            dur,
        "segments":            segments,
        "fullText":            full_text,
        "wordCount":           word_count,
        "generatedAt":         __import__("datetime").datetime.utcnow().isoformat() + "Z"
    })

if __name__ == "__main__":
    main()
