#!/usr/bin/env python3
"""
Quran Video Generator - Fast Python Video Engine
Strategy:
  - Pre-render Arabic text once per ayah as PNG via ImageMagick (no per-frame shaping)
  - Overlay PNG with FFmpeg overlay filter (fast alpha compositing)
  - ultrafast preset for all intermediate encodes
  - Parallel audio + background downloads
  - Aggressive temp-file cleanup to avoid disk quota
"""

import argparse
import json
import os
import sys
import subprocess
import tempfile
import urllib.request
import shutil
import glob as glob_mod
from concurrent.futures import ThreadPoolExecutor, as_completed

FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts")
FONT_PATH = os.path.join(FONTS_DIR, "AmiriQuran.ttf")


# ─── Utilities ────────────────────────────────────────────────────────────────

def progress(step: str, pct: float):
    print(json.dumps({"step": step, "progress": round(pct, 3)}), flush=True)


def run_ffmpeg(args: list[str], check=True) -> subprocess.CompletedProcess:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"FFmpeg error: {result.stderr}", file=sys.stderr)
        raise RuntimeError(f"FFmpeg failed: {result.stderr[:500]}")
    return result


def run_magick(args: list[str], check=True) -> subprocess.CompletedProcess:
    cmd = ["magick"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"ImageMagick error: {result.stderr}", file=sys.stderr)
        if check:
            raise RuntimeError(f"ImageMagick failed: {result.stderr[:300]}")
    return result


def safe_remove(path: str):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def get_media_duration(path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return 0.0
    data = json.loads(result.stdout)
    return float(data.get("format", {}).get("duration", 0))


def download_file(url: str, dest: str) -> bool:
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            "Referer": "https://alquran.cloud/",
            "Accept": "*/*",
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
            shutil.copyfileobj(resp, f)
        return True
    except Exception as e:
        print(f"Download failed for {url}: {e}", file=sys.stderr)
        return False


def cleanup_old_temp_dirs():
    """Remove leftover temp dirs from previous failed runs to free disk space."""
    for d in glob_mod.glob("/tmp/quran_*"):
        try:
            shutil.rmtree(d, ignore_errors=True)
            print(f"Cleaned old temp dir: {d}", file=sys.stderr)
        except Exception:
            pass


# ─── Text overlay via ImageMagick ─────────────────────────────────────────────

def render_text_png(
    text: str,
    text_style: dict,
    frame_width: int,
    frame_height: int,
    output_path: str,
) -> bool:
    """
    Render Arabic text to a full-frame transparent PNG using ImageMagick.
    Text is auto-wrapped and shaped correctly by ImageMagick/FreeType.
    Returns True on success.
    """
    font_size      = int(text_style.get("fontSize", 60))
    text_color     = text_style.get("textColor", "#FFFFFF")
    stroke_color   = text_style.get("strokeColor", "#000000")
    stroke_width   = int(text_style.get("strokeWidth", 2))
    shadow_on      = bool(text_style.get("shadowEnabled", True))
    bg_opacity     = float(text_style.get("backgroundOpacity", 0.3))
    position       = text_style.get("position", "center")
    text_width_pct = float(text_style.get("textWidth", 80)) / 100.0

    caption_width = int(frame_width * text_width_pct)
    bg_color = f"rgba(0,0,0,{bg_opacity:.2f})" if bg_opacity > 0.05 else "none"

    tmp_caption = output_path + ".cap.png"

    # ── Step 1: Render caption (auto-wraps Arabic via FreeType) ──────────────
    caption_args = [
        "-size", f"{caption_width}x",
        "-background", bg_color,
        "-font", FONT_PATH,
        "-pointsize", str(font_size),
        "-fill", text_color,
        "-gravity", "center",
    ]
    if stroke_width > 0:
        caption_args += ["-stroke", stroke_color, "-strokewidth", str(stroke_width)]
    caption_args.append(f"caption:{text}")

    if shadow_on:
        caption_args += [
            "(", "+clone",
            "-background", "black",
            "-shadow", "70x4+3+4",
            ")", "+swap",
            "-background", "none", "-flatten",
        ]

    caption_args += ["-bordercolor", "none", "-border", "12x8", tmp_caption]

    r = run_magick(caption_args, check=False)
    if r.returncode != 0 or not os.path.exists(tmp_caption):
        print(f"IM caption failed: {r.stderr}", file=sys.stderr)
        return False

    # ── Step 2: Embed on full-frame transparent canvas ────────────────────────
    if position == "top":
        gravity, offset = "North", f"+0+{int(frame_height * 0.06)}"
    elif position == "bottom":
        gravity, offset = "South", f"+0-{int(frame_height * 0.06)}"
    else:
        gravity, offset = "Center", "+0+0"

    r2 = run_magick([
        "-size", f"{frame_width}x{frame_height}", "xc:none",
        tmp_caption,
        "-gravity", gravity, "-geometry", offset, "-composite",
        output_path,
    ], check=False)

    safe_remove(tmp_caption)
    return r2.returncode == 0 and os.path.exists(output_path)


# ─── Slide creation ───────────────────────────────────────────────────────────

def create_slide(
    background_path: str,
    audio_path: str,
    text_png_path: str,
    resolution: str,
    slide_index: int,
    tmpdir: str,
    is_image: bool,
) -> str:
    """
    Create one slide MP4 with background + text overlay.
    Uses a fixed video_track_timescale so all slides share the same timebase
    (prevents xfade "timebase mismatch" errors).
    """
    w, h = resolution.split("x")
    width, height = int(w), int(h)
    duration = get_media_duration(audio_path)
    if duration <= 0:
        duration = 5.0

    slide_path = os.path.join(tmpdir, f"slide_{slide_index:04d}.mp4")

    scale_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height}"
    )
    # Video backgrounds: reset pts before scaling to prevent speed glitches
    # when stream_loop re-starts the clip mid-playback
    bg_filter = scale_filter if is_image else f"setpts=PTS-STARTPTS,{scale_filter}"
    overlay_filter = f"[0:v]{bg_filter}[bg];[bg][2:v]overlay=0:0[vout]"

    common_output = [
        "-map", "[vout]",
        "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
        "-r", "30",
        # Force consistent timebase — prevents xfade mismatch when mixing
        # image-looped slides (tbn=1/25) with video slides (tbn=1/90000)
        "-video_track_timescale", "12800",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        slide_path,
    ]

    if is_image:
        run_ffmpeg([
            "-loop", "1", "-i", background_path,
            "-i", audio_path,
            "-i", text_png_path,
            "-t", str(duration),
            "-filter_complex", overlay_filter,
        ] + common_output)
    else:
        run_ffmpeg([
            "-stream_loop", "-1", "-i", background_path,
            "-i", audio_path,
            "-i", text_png_path,
            "-t", str(duration),
            "-filter_complex", overlay_filter,
        ] + common_output)

    return slide_path


# ─── Transition / merge ───────────────────────────────────────────────────────

def apply_transition(slide_paths: list[str], transition: str, tmpdir: str) -> str:
    if len(slide_paths) == 1:
        return slide_paths[0]

    xfade_map = {
        "fade": "fade",
        "crossfade": "fade",
        "zoom": "zoomin",
        "pan": "slideleft",
        "slide": "slideright",
    }
    effect = xfade_map.get(transition)
    use_xfade = effect is not None and transition not in ("none", "")
    fade_dur = 0.8  # slightly longer for smoother feel
    output_path = os.path.join(tmpdir, "merged.mp4")
    n = len(slide_paths)

    def concat_merge():
        lst = os.path.join(tmpdir, "concat.txt")
        with open(lst, "w") as f:
            for p in slide_paths:
                f.write(f"file '{p}'\n")
        # Re-encode so pts are recalculated continuously — avoids 2-second
        # silence gaps that appear when stream copying slides with pts offsets
        run_ffmpeg([
            "-f", "concat", "-safe", "0", "-i", lst,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
            "-video_track_timescale", "12800",
            "-c:a", "aac", "-b:a", "128k",
            output_path,
        ])

    if not use_xfade:
        concat_merge()
        return output_path

    inputs = []
    for p in slide_paths:
        inputs += ["-i", p]

    fp, current_v, current_a, offset = [], "[0:v]", "[0:a]", 0.0
    for i in range(1, n):
        dur_i = get_media_duration(slide_paths[i - 1])
        offset = max(offset + dur_i - fade_dur, 0.1)
        is_last = (i == n - 1)
        out_v = "[vout]" if is_last else f"[v{i}]"
        out_a = "[aout]" if is_last else f"[a{i}]"
        fp.append(f"{current_v}[{i}:v]xfade=transition={effect}:duration={fade_dur}:offset={offset:.3f}{out_v}")
        fp.append(f"{current_a}[{i}:a]acrossfade=d={fade_dur}{out_a}")
        current_v = out_v
        current_a = out_a

    xfade_ok = False
    try:
        run_ffmpeg(inputs + [
            "-filter_complex", ";".join(fp),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
            "-r", "30",
            "-video_track_timescale", "12800",
            "-c:a", "aac", "-b:a", "192k",
            output_path,
        ])
        # FFmpeg can exit 0 but write an empty file — verify it has content
        xfade_ok = os.path.exists(output_path) and os.path.getsize(output_path) > 10_000
    except Exception as e:
        print(f"xfade failed ({e}), falling back to concat-copy", file=sys.stderr)

    if not xfade_ok:
        if os.path.exists(output_path):
            safe_remove(output_path)
        concat_merge()

    return output_path


# ─── Parallel download helpers ────────────────────────────────────────────────

def download_audio_task(args_tuple):
    i, ayah, reciter_subfolder, tmpdir = args_tuple
    audio_url = ayah.get("audio", "")
    if not audio_url:
        g = ayah["number"]
        audio_url = f"https://cdn.islamic.network/quran/audio/128/{reciter_subfolder}/{g}.mp3"
    dest = os.path.join(tmpdir, f"audio_{i:04d}.mp3")
    ok = download_file(audio_url, dest)
    if not ok or not os.path.exists(dest) or os.path.getsize(dest) < 100:
        run_ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                    "-t", "3", "-c:a", "libmp3lame", dest])
    return i, dest


def download_bg_task(args_tuple):
    i, bg, tmpdir = args_tuple
    ext = ".jpg" if bg.get("type") == "image" else ".mp4"
    dest = os.path.join(tmpdir, f"bg_{i:04d}{ext}")
    ok = download_file(bg["url"], dest)
    if ok and os.path.exists(dest) and os.path.getsize(dest) > 100:
        return i, dest, bg.get("type", "image")
    return i, None, None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Clean leftover temp dirs from previous failed runs first
    cleanup_old_temp_dirs()

    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--request-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reciter-api", required=True)
    parser.add_argument("--api-base", required=False, default="")
    args = parser.parse_args()

    with open(args.request_file) as f:
        req = json.load(f)

    surah_number = req["surahNumber"]
    from_ayah    = req["fromAyah"]
    to_ayah      = req["toAyah"]
    reciter_id   = req["reciterId"]
    backgrounds  = req["backgrounds"]
    text_style   = req["textStyle"]
    transition   = req.get("transition", "fade")
    resolution   = req.get("resolution", "1080x1920")
    fps          = req.get("fps", 30)

    w, h = resolution.split("x")
    width, height = int(w), int(h)

    import urllib.request as urlreq

    with tempfile.TemporaryDirectory(prefix=f"quran_{args.job_id}_") as tmpdir:

        # ── 1. Resolve reciter ────────────────────────────────────────────────
        progress("Resolving reciter...", 0.02)
        try:
            with urlreq.urlopen(args.reciter_api, timeout=10) as resp:
                reciters = json.loads(resp.read())
        except Exception as e:
            print(f"Failed to fetch reciters: {e}", file=sys.stderr)
            sys.exit(1)

        reciter = next((r for r in reciters if r["id"] == reciter_id), None)
        if not reciter:
            print(f"Reciter {reciter_id} not found", file=sys.stderr)
            sys.exit(1)
        reciter_subfolder = reciter.get("subfolder", "ar.alafasy")

        # ── 2. Fetch ayahs ────────────────────────────────────────────────────
        progress("Fetching Quran text...", 0.04)
        QURAN_API = "https://api.alquran.cloud/v1"
        surah_data = None
        for edition in [reciter_subfolder, "ar.alafasy"]:
            try:
                url = f"{QURAN_API}/surah/{surah_number}/{edition}"
                r = urlreq.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urlreq.urlopen(r, timeout=30) as resp:
                    surah_data = json.loads(resp.read())
                break
            except Exception as e:
                print(f"Edition {edition} failed: {e}", file=sys.stderr)
        if not surah_data:
            print("Failed to fetch surah", file=sys.stderr)
            sys.exit(1)

        all_ayahs = surah_data["data"]["ayahs"]
        selected  = [a for a in all_ayahs if from_ayah <= a["numberInSurah"] <= to_ayah]
        if not selected:
            print("No ayahs selected", file=sys.stderr)
            sys.exit(1)

        # ── 3. Parallel downloads: audio + backgrounds ────────────────────────
        progress("Downloading audio + backgrounds...", 0.07)

        audio_paths = [None] * len(selected)
        bg_path_map: dict[int, tuple[str, str]] = {}

        audio_tasks = [(i, a, reciter_subfolder, tmpdir) for i, a in enumerate(selected)]
        bg_tasks    = [(i, bg, tmpdir) for i, bg in enumerate(backgrounds)]

        with ThreadPoolExecutor(max_workers=6) as pool:
            audio_futs = {pool.submit(download_audio_task, t): "audio" for t in audio_tasks}
            bg_futs    = {pool.submit(download_bg_task,    t): "bg"    for t in bg_tasks}
            all_futs   = list(audio_futs) + list(bg_futs)
            done = 0
            total = len(all_futs)
            for fut in as_completed(all_futs):
                done += 1
                pct = 0.07 + 0.23 * (done / total)
                if fut in audio_futs:
                    idx, dest = fut.result()
                    audio_paths[idx] = dest
                    progress(f"Downloaded audio {idx+1}/{len(selected)}...", pct)
                else:
                    idx, dest, btype = fut.result()
                    if dest:
                        bg_path_map[idx] = (dest, btype or "image")
                        progress(f"Downloaded background {idx+1}/{len(backgrounds)}...", pct)

        # Ordered background list
        bg_ordered = [bg_path_map.get(i) for i in range(len(backgrounds))]
        bg_ordered = [(p, t) for p, t in bg_ordered if p is not None]

        if not bg_ordered:
            fallback = os.path.join(tmpdir, "fallback.jpg")
            run_ffmpeg(["-f", "lavfi", "-i", f"color=c=0x1a1a2e:size={width}x{height}:r=1",
                        "-vframes", "1", fallback])
            bg_ordered = [(fallback, "image")]

        # ── 4. Render text PNGs (once per ayah, NOT per frame) ────────────────
        progress("Rendering Arabic text overlays...", 0.30)
        text_pngs = []
        for i, ayah in enumerate(selected):
            tp = os.path.join(tmpdir, f"text_{i:04d}.png")
            ok = render_text_png(ayah["text"], text_style, width, height, tp)
            if not ok or not os.path.exists(tp):
                run_magick(["-size", f"{width}x{height}", "xc:none", tp], check=False)
            text_pngs.append(tp)
            progress(f"Text overlay {i+1}/{len(selected)}...",
                     0.30 + 0.05 * ((i + 1) / len(selected)))

        # ── 5. Create slides, delete source files immediately ─────────────────
        progress("Rendering slides...", 0.35)
        slide_paths = []
        for i, (ayah, audio_path, text_png) in enumerate(zip(selected, audio_paths, text_pngs)):
            bi, (bg_path, bg_type) = i % len(bg_ordered), bg_ordered[i % len(bg_ordered)]

            sp = create_slide(
                background_path=bg_path,
                audio_path=audio_path,
                text_png_path=text_png,
                resolution=resolution,
                slide_index=i,
                tmpdir=tmpdir,
                is_image=(bg_type == "image"),
            )
            slide_paths.append(sp)

            # Free disk space immediately — these are no longer needed
            safe_remove(audio_path)
            safe_remove(text_png)
            # Only remove bg if it won't be reused by a later slide
            next_users = [j for j in range(i + 1, len(selected)) if j % len(bg_ordered) == bi]
            if not next_users:
                safe_remove(bg_path)

            pct = 0.35 + 0.45 * ((i + 1) / len(selected))
            progress(f"Rendering ayah {i+1}/{len(selected)}...", pct)

        # ── 6. Merge with transitions ─────────────────────────────────────────
        progress("Merging slides...", 0.80)
        if len(slide_paths) > 1:
            merged = apply_transition(slide_paths, transition, tmpdir)
            # Free individual slides after merging
            for sp in slide_paths:
                if sp != merged:
                    safe_remove(sp)
        else:
            merged = slide_paths[0]

        # ── 7. Final mux — just copy streams + faststart (no re-encode) ─────────
        progress("Finalizing...", 0.92)
        r = run_ffmpeg([
            "-i", merged,
            "-c", "copy",
            "-movflags", "+faststart",
            args.output,
        ], check=False)
        if r.returncode != 0:
            # Fallback: ultrafast re-encode if copy fails (codec mismatch)
            run_ffmpeg([
                "-i", merged,
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                args.output,
            ])

    progress("Finished", 1.0)
    sys.exit(0)


if __name__ == "__main__":
    main()
