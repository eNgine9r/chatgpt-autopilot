#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjects } from "../src/config.mjs";
import { applyBrowserV2PolicyDocument, browserV2PolicySummary, parseProjectRepositories } from "../src/browser-v2-policy.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectsFile = path.resolve(process.env.PROJECTS_FILE || path.join(appDir, "config/projects.json"));
if (process.argv.includes("--execute")) throw new Error("standalone_policy_mutation_disabled_use_promotion_gate");
const assignments = parseProjectRepositories(process.argv.slice(2).filter((value) => !value.startsWith("--")));
if (!fs.existsSync(projectsFile)) throw new Error(`missing_projects_file:${projectsFile}`);
const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
const next = applyBrowserV2PolicyDocument(raw, assignments);
const targetIds = [...assignments.keys()];
const validateFile = `${projectsFile}.${process.pid}.validate`;
fs.writeFileSync(validateFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
try {
  loadProjects(validateFile);
} finally {
  try { fs.unlinkSync(validateFile); } catch {}
}
console.log(JSON.stringify({
  ok: true,
  mode: "preview",
  projectsFile,
  projects: browserV2PolicySummary(next, targetIds)
}, null, 2));
