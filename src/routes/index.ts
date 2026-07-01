import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import quranRouter from "./quran.js";
import backgroundsRouter from "./backgrounds.js";
import generateRouter from "./generate.js";
import youtubeRouter from "./youtube.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quranRouter);
router.use(backgroundsRouter);
router.use(generateRouter);
router.use(youtubeRouter);

export default router;
