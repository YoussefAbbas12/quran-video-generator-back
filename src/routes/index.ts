import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quranRouter from "./quran";
import backgroundsRouter from "./backgrounds";
import generateRouter from "./generate";
import youtubeRouter from "./youtube";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quranRouter);
router.use(backgroundsRouter);
router.use(generateRouter);
router.use(youtubeRouter);

export default router;
