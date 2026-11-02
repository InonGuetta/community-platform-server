import "dotenv/config";
import fs from "node:fs";
import { getTranscriptByMediaId } from "./services/servicesTranscripts.js";
import { UNRESTRICTED } from "./lib/permissions.js";
import { pool } from "./db/pool.js";
const out = {};
for (const id of [29, 12]) out[id] = await getTranscriptByMediaId(id, { courses: UNRESTRICTED, drafts: UNRESTRICTED });
fs.writeFileSync("C:/Users/inon1/AppData/Local/Temp/claude/c--Users-inon1-projects-yeshiva-project/fc410945-75e3-48d9-86fb-e7a89f51ce95/scratchpad/transcripts.json", JSON.stringify(out));
await pool.end();
