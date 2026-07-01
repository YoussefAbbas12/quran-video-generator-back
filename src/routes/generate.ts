import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";

// Resolve python full path at startup
let python3Bin = "python3";
try {
  python3Bin = execSync("which python3", { encoding: "utf8" }).trim();
} catch {
  try {
    python3Bin = execSync("which python", { encoding: "utf8" }).trim();
  } catch {
    // fallback — will fail at spawn time with a clear error
  }
}
import {
  StartGenerationBody,
  StartGenerationResponse,
  GetGenerationStatusQueryParams,
  GetGenerationStatusResponse,
  GetDownloadUrlQueryParams,
  GetDownloadUrlResponse,
} from "../lib/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const backendRoot = process.cwd();

const outputDir = path.resolve(backendRoot, "generated");
const pythonScript = path.resolve(backendRoot, "python/generate_video.py");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

interface Job {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  step: string;
  error: string | null;
  outputPath: string | null;
}

export const jobs = new Map<string, Job>();
export { outputDir };

router.post("/generate", async (req, res): Promise<void> => {
  const parsed = StartGenerationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const jobId = randomUUID();
  const job: Job = {
    jobId,
    status: "pending",
    progress: 0,
    step: "Queued",
    error: null,
    outputPath: null,
  };
  jobs.set(jobId, job);

  const outputPath = path.resolve(outputDir, `${jobId}.mp4`);
  const requestJsonPath = path.resolve(outputDir, `${jobId}.json`);
  fs.writeFileSync(requestJsonPath, JSON.stringify(parsed.data, null, 2));

  job.status = "running";
  job.step = "Starting...";

  const reciterApiUrl = `http://localhost:${process.env.PORT}/api/quran/reciters`;

  const args = [
    pythonScript,
    "--job-id", jobId,
    "--request-file", requestJsonPath,
    "--output", outputPath,
    "--reciter-api", reciterApiUrl,
  ];

  logger.info({ jobId, args }, "Spawning Python video generation");

  const pythonProcess = spawn(python3Bin, args, {
    env: {
      ...process.env,
    },
  });

  pythonProcess.stdout.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    try {
      const update = JSON.parse(line) as { progress?: number; step?: string };
      if (update.step !== undefined) job.step = update.step;
      if (update.progress !== undefined) job.progress = update.progress;
    } catch {
      logger.debug({ jobId, line }, "Python stdout");
    }
  });

  pythonProcess.stderr.on("data", (data: Buffer) => {
    logger.warn({ jobId, stderr: data.toString().trim() }, "Python stderr");
  });

  pythonProcess.on("close", (code) => {
    if (code === 0 && fs.existsSync(outputPath)) {
      job.status = "completed";
      job.progress = 1;
      job.step = "Finished";
      job.outputPath = outputPath;
      logger.info({ jobId }, "Video generation completed");
    } else {
      job.status = "failed";
      job.error = `Process exited with code ${code}`;
      logger.error({ jobId, code }, "Video generation failed");
    }
  });

  pythonProcess.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
    logger.error({ jobId, err }, "Failed to start Python process");
  });

  res.status(202).json(StartGenerationResponse.parse(job));
});

router.get("/generate/status", async (req, res): Promise<void> => {
  const parsed = GetGenerationStatusQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { jobId } = parsed.data;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(GetGenerationStatusResponse.parse(job));
});

router.get("/generate/download-url", async (req, res): Promise<void> => {
  const parsed = GetDownloadUrlQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { jobId } = parsed.data;
  const job = jobs.get(jobId);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Job not found or not completed" });
    return;
  }

  res.json(
    GetDownloadUrlResponse.parse({
      url: `/api/generate/download?jobId=${jobId}`,
      jobId,
    }),
  );
});

router.get("/generate/download", async (req, res): Promise<void> => {
  const jobId = req.query["jobId"] as string;
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const job = jobs.get(jobId);
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="quran-${jobId}.mp4"`);
  fs.createReadStream(job.outputPath).pipe(res as import("stream").Writable);
});

export default router;
