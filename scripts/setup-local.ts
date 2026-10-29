import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const password = randomBytes(24).toString("hex");
const secret = randomBytes(32).toString("hex");
const storage = path.resolve(".data/media");
await mkdir(storage, { recursive: true });
try {
  await writeFile(
    ".env.local",
    `FLOWBLOCK_LOCAL_MODE=1\nAPP_URL=http://127.0.0.1:3037\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://flowblock:${password}@127.0.0.1:54379/flowblock\nAUTH_SECRET=${secret}\nFLOWBLOCK_STORAGE_DIR=${storage}\nWANDB_PROJECT=flowblock\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created .env.local with local credentials and an absolute media directory.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.log(".env.local already exists; its configuration was preserved.");
}
