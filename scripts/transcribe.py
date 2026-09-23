# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "faster-whisper>=1.0.0",
# ]
# ///
"""
Transcription script — run via: uv run scripts/transcribe.py <args>
Outputs JSON to stdout, progress to stderr.
"""
import sys
import json
import argparse
import os

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="Path to audio file")
    parser.add_argument("--model", default="base", choices=["tiny","base","small","medium","large"])
    parser.add_argument("--language", default=None, help="Language code (auto-detect if not set)")
    parser.add_argument("--cache-dir", default=None, help="Directory to cache models")
    args = parser.parse_args()

    print(json.dumps({"type":"progress","message":"Loading faster-whisper model...","progress":0.05}), flush=True)

    from faster_whisper import WhisperModel

    model_dir = args.cache_dir or os.path.join(os.path.expanduser("~"), ".cache", "whisper-models")
    os.makedirs(model_dir, exist_ok=True)

    print(json.dumps({"type":"progress","message":f"Initializing model '{args.model}'...","progress":0.10}), flush=True)

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=model_dir
    )

    print(json.dumps({"type":"progress","message":"Transcribing audio...","progress":0.20}), flush=True)

    segments_iter, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    print(json.dumps({"type":"progress","message":f"Language detected: {info.language} (confidence: {info.language_probability:.2f})","progress":0.25}), flush=True)

    segments = []
    i = 0
    for seg in segments_iter:
        i += 1
        progress = min(0.25 + (i / max(1, 300)) * 0.70, 0.95)
        print(json.dumps({
            "type": "progress",
            "message": f"Segment {i}: {seg.text.strip()[:60]}...",
            "progress": progress
        }), flush=True)

        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3)
                })

        segments.append({
            "id": f"N{i:03d}",
            "text": seg.text.strip(),
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "duration": round(seg.end - seg.start, 3),
            "words": words
        })

    full_text = " ".join(s["text"] for s in segments)
    word_count = len(full_text.split())

    result = {
        "type": "result",
        "language": info.language,
        "languageProbability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "segments": segments,
        "fullText": full_text,
        "wordCount": word_count,
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z"
    }

    print(json.dumps({"type":"progress","message":f"Done — {len(segments)} segments, {word_count} words","progress":1.0}), flush=True)
    print(json.dumps(result), flush=True)

if __name__ == "__main__":
    main()
