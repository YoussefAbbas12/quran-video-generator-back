# Quran Video Generator — Backend

## System Requirements
- **Node.js** 18+
- **Python** 3.9+
- **FFmpeg** — `apt install ffmpeg` or `brew install ffmpeg`
- **ImageMagick** — `apt install imagemagick` or `brew install imagemagick`

## Setup
```bash
npm install      # install Node dependencies
npm run build    # compile TypeScript → dist/
npm start        # start server on port 8080
```

## Environment Variables
Copy `.env.example` to `.env`:
- `PORT` — server port (default: 8080)
- `PEXELS_API_KEY` — Pexels API key for background videos

## Deploy on Railway / Render / VPS
1. Copy this folder to your server
2. Run `npm install && npm run build && npm start`
3. Make sure FFmpeg and ImageMagick are installed on the server

## Generated videos
Videos are saved in the `generated/` folder.
They are automatically deleted after uploading to YouTube.
