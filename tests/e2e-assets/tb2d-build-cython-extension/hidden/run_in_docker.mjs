import { spawnSync } from "node:child_process";
import process from "node:process";

const image = "python:3.11-bookworm";
const workspace = process.cwd();
const command = [
  "python -m pip install --disable-pip-version-check numpy==2.3.1 Cython==3.1.2 setuptools wheel pytest",
  "python .benchmark/hidden/verify_build.py",
].join(" && ");

const result = spawnSync("docker", [
  "run", "--rm",
  "--network", "bridge",
  "-v", `${workspace}:/workspace`,
  "-w", "/workspace",
  image,
  "sh", "-lc", command,
], { stdio: "inherit", windowsHide: true });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
