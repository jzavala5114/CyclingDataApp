import "dotenv/config";
import cors from "cors";
import express from "express";
import { segmentsRouter } from "./routes/segments.js";
import { sessionsRouter } from "./routes/sessions.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/sessions", sessionsRouter);
app.use("/segments", segmentsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`backend listening on :${port}`);
});
