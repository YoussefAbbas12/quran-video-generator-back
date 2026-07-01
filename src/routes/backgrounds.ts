import { Router, type IRouter } from "express";
import { SearchBackgroundsQueryParams, SearchBackgroundsResponse } from "../lib/api-zod";

const router: IRouter = Router();

router.get("/backgrounds/search", async (req, res): Promise<void> => {
  const parsed = SearchBackgroundsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { query, type, page = 1, perPage = 20 } = parsed.data;
  const pexelsKey = (req.headers["x-pexels-api-key"] as string) || process.env.PEXELS_API_KEY || "";

  if (!pexelsKey) {
    res.status(400).json({ error: "Pexels API key required. Set it in Settings." });
    return;
  }

  try {
    const mediaType = type === "videos" ? "videos" : "photos";
    const endpoint =
      mediaType === "videos"
        ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`
        : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;

    const response = await fetch(endpoint, {
      headers: { Authorization: pexelsKey },
    });

    if (!response.ok) {
      const errText = await response.text();
      req.log.warn({ status: response.status, errText }, "Pexels API error");
      res.status(502).json({ error: "Pexels API request failed" });
      return;
    }

    const json = await response.json() as Record<string, unknown>;

    let results: Array<{
      id: number | null;
      type: "image" | "video";
      thumbnailUrl: string;
      url: string;
      width: number;
      height: number;
      duration: number | null;
      photographer: string | null;
    }> = [];

    let totalResults = 0;

    if (mediaType === "photos") {
      const photos = json as {
        total_results: number;
        photos: Array<{
          id: number;
          width: number;
          height: number;
          photographer: string;
          src: { large2x: string; medium: string };
        }>;
      };
      totalResults = photos.total_results;
      results = (photos.photos || []).map((p) => ({
        id: p.id,
        type: "image" as const,
        thumbnailUrl: p.src.medium,
        url: p.src.large2x,
        width: p.width,
        height: p.height,
        duration: null,
        photographer: p.photographer,
      }));
    } else {
      const videos = json as {
        total_results: number;
        videos: Array<{
          id: number;
          width: number;
          height: number;
          user: { name: string };
          duration: number;
          image: string;
          video_files: Array<{ quality: string; link: string; width: number; height: number }>;
        }>;
      };
      totalResults = videos.total_results;
      results = (videos.videos || []).map((v) => {
        // Prefer SD to keep file sizes small; fall back to HD only if SD missing
        const bestFile =
          v.video_files.find((f) => f.quality === "sd") ||
          v.video_files.find((f) => f.quality === "hd") ||
          v.video_files[0];
        return {
          id: v.id,
          type: "video" as const,
          thumbnailUrl: v.image,
          url: bestFile?.link ?? "",
          width: v.width,
          height: v.height,
          duration: v.duration,
          photographer: v.user?.name ?? null,
        };
      });
    }

    res.json(
      SearchBackgroundsResponse.parse({
        results,
        totalResults,
        page: Number(page),
        perPage: Number(perPage),
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Error searching backgrounds");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
