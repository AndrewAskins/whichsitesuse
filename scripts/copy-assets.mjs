// tsc only emits .js; copy the SQL files the build needs next to them.
import { cpSync } from "node:fs";
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
cpSync("src/pipeline/sql", "dist/pipeline/sql", { recursive: true });
