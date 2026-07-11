import json
import os
from livereload import Server

MUSIC_DIR = "music"
MUSIC_MANIFEST_PATH = os.path.join(MUSIC_DIR, "manifest.json")
AUDIO_EXTENSIONS = (".mp3", ".m4a", ".ogg", ".wav", ".flac", ".aac")

PHOTOS_DIR = "photos"
PHOTOS_MANIFEST_PATH = os.path.join(PHOTOS_DIR, "manifest.json")
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")


def _build_manifest(folder, manifest_path, extensions, label, key):
    """Scan `folder` and write a manifest.json listing every file in it
    matching `extensions`, so the front-end can discover files without
    needing a real directory-listing API."""
    if not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)

    files = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(extensions)
    )

    with open(manifest_path, "w") as f:
        json.dump({key: files}, f, indent=2)

    print(f"[serve.py] {label} manifest updated: {files}")


def build_music_manifest():
    # key is "tracks" — script.js reads data.tracks
    _build_manifest(MUSIC_DIR, MUSIC_MANIFEST_PATH, AUDIO_EXTENSIONS, "music", "tracks")


def build_photos_manifest():
    # key is "files" — gallery.js reads data.files
    _build_manifest(PHOTOS_DIR, PHOTOS_MANIFEST_PATH, IMAGE_EXTENSIONS, "photos", "files")


def _case_insensitive_glob(ext):
    """Turn '.jpg' into '*.[jJ][pP][gG]' so the filesystem watcher catches
    files regardless of extension casing (JPG, Jpg, jpg, etc.) — the glob
    patterns used for watching are case-sensitive even on
    case-insensitive filesystems."""
    pattern = ''.join(f'[{c.lower()}{c.upper()}]' if c.isalpha() else c for c in ext)
    return f'*{pattern}'


# Build both manifests once at startup...
build_music_manifest()
build_photos_manifest()

server = Server()

# Watch each extension's glob pattern individually (rather than the whole
# folder) so manifest.json itself is never part of the watch list —
# otherwise writing the manifest would re-trigger the watcher that writes
# it, looping forever. Patterns are case-insensitive so .JPG/.Jpg/.jpg
# (etc.) are all picked up.
for ext in AUDIO_EXTENSIONS:
    server.watch(f"{MUSIC_DIR}/{_case_insensitive_glob(ext)}", build_music_manifest)

for ext in IMAGE_EXTENSIONS:
    server.watch(f"{PHOTOS_DIR}/{_case_insensitive_glob(ext)}", build_photos_manifest)

# Watch all HTML, CSS, and JS files in the directory for changes
server.watch("*.html")
server.watch("*.css")
server.watch("*.js")

# Serve the website (Defaults to http://127.0.0.1:5500)
server.serve(root=".")