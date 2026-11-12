import { spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const zipName = "ffmpeg-master-latest-win64-gpl.zip";
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${zipName}`;
const dest = join(dirname(fileURLToPath(import.meta.url)), "ffmpeg");
const ffmpeg = join(dest, "ffmpeg.exe");
const ffprobe = join(dest, "ffprobe.exe");

if (existsSync(ffmpeg) && existsSync(ffprobe) && existsSync(join(dest, "LICENSE"))) {
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
const scratch = join(tmpdir(), "filepad-ffmpeg");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const zip = join(scratch, zipName);

console.log("Downloading ffmpeg…");
const response = await fetch(url);
if (!response.ok || !response.body) {
  throw new Error(`Can't download ffmpeg (${response.status}).`);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));

const extracted = join(scratch, "unpack");
mkdirSync(extracted, { recursive: true });
const unpack = spawnSync("tar", ["-xf", zip, "-C", extracted], { stdio: "inherit" });
if (unpack.status !== 0) {
  throw new Error("Can't unpack ffmpeg.");
}

const files = walk(extracted);
const base = (file) => (file.split(/[/\\]/).pop() ?? "").toLowerCase();
const ffmpegSrc = files.find((file) => base(file) === "ffmpeg.exe");
const ffprobeSrc = files.find((file) => base(file) === "ffprobe.exe");
const licenseSrc = files
  .filter((file) => /^(license|copying)/i.test(base(file)))
  .sort((left, right) => left.length - right.length)[0];
if (!ffmpegSrc || !ffprobeSrc || !licenseSrc) {
  throw new Error("The ffmpeg download is missing ffmpeg.exe, ffprobe.exe, or its license.");
}

copyFileSync(ffmpegSrc, ffmpeg);
copyFileSync(ffprobeSrc, ffprobe);
copyFileSync(licenseSrc, join(dest, "LICENSE"));
rmSync(scratch, { recursive: true, force: true });

for (const bin of [ffmpeg, ffprobe]) {
  const check = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (check.status !== 0) {
    rmSync(ffmpeg, { force: true });
    rmSync(ffprobe, { force: true });
    rmSync(join(dest, "LICENSE"), { force: true });
    throw new Error(`${bin} does not run.`);
  }
}
console.log("Video tools are ready.");

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}
