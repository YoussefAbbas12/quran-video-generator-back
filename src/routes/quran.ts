import { Router, type IRouter } from "express";
import {
  GetSurahsResponse,
  GetAyahsQueryParams,
  GetAyahsResponse,
  GetRecitersResponse,
  GetAyahAudioUrlQueryParams,
  GetAyahAudioUrlResponse,
} from "../lib/api-zod";

const router: IRouter = Router();

const QURAN_API_BASE = "https://api.alquran.cloud/v1";
const AUDIO_CDN_BASE = "https://cdn.islamic.network/quran/audio";

router.get("/quran/surahs", async (req, res): Promise<void> => {
  try {
    const response = await fetch(`${QURAN_API_BASE}/surah`);
    if (!response.ok) {
      res.status(502).json({ error: "Failed to fetch surahs" });
      return;
    }
    const json = (await response.json()) as {
      data: Array<{
        number: number;
        name: string;
        englishName: string;
        englishNameTranslation: string;
        numberOfAyahs: number;
        revelationType: string;
      }>;
    };
    const surahs = json.data.map((s) => ({
      number: s.number,
      name: s.name,
      englishName: s.englishName,
      englishNameTranslation: s.englishNameTranslation,
      numberOfAyahs: s.numberOfAyahs,
      revelationType: s.revelationType,
    }));
    res.json(GetSurahsResponse.parse(surahs));
  } catch (err) {
    req.log.error({ err }, "Error fetching surahs");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/quran/ayahs", async (req, res): Promise<void> => {
  const parsed = GetAyahsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { surahNumber, from, to } = parsed.data;

  try {
    const response = await fetch(
      `${QURAN_API_BASE}/surah/${surahNumber}/ar.alafasy`,
    );
    if (!response.ok) {
      res.status(502).json({ error: "Failed to fetch ayahs" });
      return;
    }
    const json = (await response.json()) as {
      data: {
        ayahs: Array<{
          number: number;
          numberInSurah: number;
          text: string;
        }>;
      };
    };

    let ayahs = json.data.ayahs.map((a) => ({
      number: a.number,
      numberInSurah: a.numberInSurah,
      text: a.text,
      surahNumber: surahNumber as number,
    }));

    if (from !== undefined) {
      ayahs = ayahs.filter((a) => a.numberInSurah >= from);
    }
    if (to !== undefined) {
      ayahs = ayahs.filter((a) => a.numberInSurah <= to);
    }

    res.json(GetAyahsResponse.parse(ayahs));
  } catch (err) {
    req.log.error({ err }, "Error fetching ayahs");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/quran/reciters", async (req, res): Promise<void> => {
  try {
    const response = await fetch(`${QURAN_API_BASE}/edition?format=audio&language=ar&type=versebyverse`);
    if (!response.ok) {
      res.status(502).json({ error: "Failed to fetch reciters" });
      return;
    }
    const json = (await response.json()) as {
      data: Array<{
        identifier: string;
        name: string;
        englishName: string;
        type: string;
      }>;
    };

    const reciters = json.data.map((r, idx) => ({
      id: idx + 1,
      name: r.englishName,
      nameArabic: r.name,
      style: r.type,
      subfolder: r.identifier,
    }));

    res.json(GetRecitersResponse.parse(reciters));
  } catch (err) {
    req.log.error({ err }, "Error fetching reciters");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/quran/audio", async (req, res): Promise<void> => {
  const parsed = GetAyahAudioUrlQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { reciterId, surahNumber, ayahNumber } = parsed.data;

  try {
    const reciterResponse = await fetch(
      `${QURAN_API_BASE}/edition?format=audio&language=ar&type=versebyverse`,
    );
    if (!reciterResponse.ok) {
      res.status(502).json({ error: "Failed to resolve reciter" });
      return;
    }
    const reciterJson = (await reciterResponse.json()) as {
      data: Array<{ identifier: string }>;
    };
    const reciterList = reciterJson.data;
    const reciter = reciterList[(reciterId as number) - 1];
    if (!reciter) {
      res.status(404).json({ error: "Reciter not found" });
      return;
    }

    const paddedSurah = String(surahNumber).padStart(3, "0");
    const paddedAyah = String(ayahNumber).padStart(3, "0");
    const audioUrl = `${AUDIO_CDN_BASE}/64/${reciter.identifier}/${paddedSurah}${paddedAyah}.mp3`;

    res.json(
      GetAyahAudioUrlResponse.parse({
        url: audioUrl,
        surahNumber,
        ayahNumber,
        reciterId,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Error fetching audio URL");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Audio proxy — downloads the MP3 from the CDN server-side and streams it back.
// This avoids 403 errors that some CDNs return for direct server-to-server requests
// with non-browser User-Agents made by the Python video engine.
router.get("/quran/audio-proxy", async (req, res): Promise<void> => {
  const { identifier, surah, ayah } = req.query as Record<string, string>;
  if (!identifier || !surah || !ayah) {
    res.status(400).json({ error: "identifier, surah, ayah are required" });
    return;
  }
  const audioUrl = `${AUDIO_CDN_BASE}/64/${identifier}/${surah}${ayah}.mp3`;
  try {
    const upstream = await fetch(audioUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuranVideoGenerator/1.0)",
        "Referer": "https://alquran.cloud/",
      },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `CDN returned ${upstream.status}` });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err, audioUrl }, "Error proxying audio");
    res.status(500).json({ error: "Failed to proxy audio" });
  }
});

export default router;
