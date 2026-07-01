import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import https from "https";
import { UploadToYoutubeBody, UploadToYoutubeResponse } from "../lib/api-zod";
import { jobs, outputDir } from "./generate";

const router: IRouter = Router();

router.post("/youtube/upload", async (req, res): Promise<void> => {
  const parsed = UploadToYoutubeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { jobId, title, description, tags, visibility, scheduledAt, thumbnailUrl } = parsed.data;
  const videoPath = path.resolve(outputDir, `${jobId}.mp4`);

  if (!fs.existsSync(videoPath)) {
    res.status(404).json({ error: "Video file not found. Generate the video first." });
    return;
  }

  const clientId = (req.headers["x-youtube-client-id"] as string) || process.env.YOUTUBE_CLIENT_ID || "";
  const clientSecret = (req.headers["x-youtube-client-secret"] as string) || process.env.YOUTUBE_CLIENT_SECRET || "";
  const refreshToken = (req.headers["x-youtube-refresh-token"] as string) || process.env.YOUTUBE_REFRESH_TOKEN || "";

  if (!clientId || !clientSecret || !refreshToken) {
    res.status(400).json({
      error: "YouTube credentials required. Set Client ID, Client Secret, and Refresh Token in Settings.",
    });
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      req.log.error({ errText }, "Failed to refresh YouTube token");
      res.status(401).json({ error: "Failed to authenticate with YouTube. Check your credentials." });
      return;
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const accessToken = tokenData.access_token;

    const privacyStatus =
      visibility === "public" ? "public" :
      visibility === "private" ? "private" :
      "unlisted";

    const metadata: Record<string, unknown> = {
      snippet: {
        title,
        description,
        tags,
        categoryId: "22",
      },
      status: {
        privacyStatus,
        ...(scheduledAt ? { publishAt: scheduledAt } : {}),
      },
    };

    const videoStats = fs.statSync(videoPath);
    const videoSize = videoStats.size;

    const initResponse = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(videoSize),
        },
        body: JSON.stringify(metadata),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!initResponse.ok) {
      const errText = await initResponse.text();
      req.log.error({ errText }, "Failed to initialize YouTube upload");
      res.status(502).json({ error: "Failed to initiate YouTube upload." });
      return;
    }

    const uploadUrl = initResponse.headers.get("Location");
    if (!uploadUrl) {
      res.status(502).json({ error: "No upload URL returned from YouTube." });
      return;
    }

    const uploadData = await new Promise<{ id: string; status: { uploadStatus: string } }>((resolve, reject) => {
      const parsedUrl = new URL(uploadUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": videoSize,
        },
      };

      const uploadReq = https.request(options, (uploadRes) => {
        let data = "";
        uploadRes.on("data", (chunk) => {
          data += chunk;
        });
        uploadRes.on("end", () => {
          if (uploadRes.statusCode && uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Failed to parse response JSON: ${data}`));
            }
          } else {
            reject(new Error(`Upload failed with status ${uploadRes.statusCode}: ${data}`));
          }
        });
      });

      uploadReq.on("error", (err) => {
        reject(err);
      });

      const videoStream = fs.createReadStream(videoPath);
      videoStream.pipe(uploadReq);
    });

    const videoId = uploadData.id;
    // Use /shorts/ URL so YouTube treats it as a Short (requires #Shorts in title/desc too)
    const videoUrl = `https://www.youtube.com/shorts/${videoId}`;

    if (thumbnailUrl && thumbnailUrl.startsWith("http")) {
      try {
        const thumbResponse = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(10000) });
        if (thumbResponse.ok) {
          const thumbBuffer = await thumbResponse.arrayBuffer();
          const contentType = thumbResponse.headers.get("content-type") || "image/jpeg";
          await fetch(
            `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": contentType,
                "Content-Length": String(thumbBuffer.byteLength),
              },
              body: thumbBuffer,
              signal: AbortSignal.timeout(15000),
            },
          );
        }
      } catch (thumbErr) {
        req.log.warn({ thumbErr }, "Thumbnail upload failed (non-fatal)");
      }
    }

    // Delete both the .mp4 video and the .json request file, and clear the job from memory
    const jsonPath = path.resolve(outputDir, `${jobId}.json`);
    for (const filePath of [videoPath, jsonPath]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (delErr) {
        req.log.warn({ delErr, filePath }, "Could not delete file after upload (non-fatal)");
      }
    }
    jobs.delete(jobId);
    req.log.info({ jobId }, "Cleaned up job files and memory after YouTube upload");

    res.json(
      UploadToYoutubeResponse.parse({
        videoId,
        url: videoUrl,
        status: uploadData.status?.uploadStatus ?? "uploaded",
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Error uploading to YouTube");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
