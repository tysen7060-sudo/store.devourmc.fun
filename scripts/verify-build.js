"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function checkScript(label, source) {
  try {
    new vm.Script(source, { filename: label });
  } catch (error) {
    console.error(`${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

function warn(message) {
  console.warn(`Warning: ${message}`);
}

function walk(dir, options = {}) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) {
    if (options.optional) {
      warn(`optional path not found, skipping: ${dir}`);
      return [];
    }
    console.error(`Required path not found: ${dir}`);
    process.exitCode = 1;
    return [];
  }

  return fs.readdirSync(full, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(relative, options) : [relative];
  });
}

function existingFiles(files) {
  return files.filter(file => {
    if (fs.existsSync(path.join(root, file))) return true;
    warn(`optional file not found, skipping: ${file}`);
    return false;
  });
}

function assetFiles() {
  const assetDirs = ["images", path.join("public", "images"), path.join("src", "assets")];
  const files = assetDirs.flatMap(dir => walk(dir, { optional: true }));
  return [
    ...existingFiles(["1server-icon.png", "devourmc-logo.png"]),
    ...files
  ];
}

const html = read("index.html");
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);

if (!scriptMatch) {
  console.error("index.html: inline application script not found");
  process.exitCode = 1;
} else {
  checkScript("index.html inline script", scriptMatch[1]);
}

for (const file of walk("api").filter(file => file.endsWith(".js"))) {
  checkScript(file, read(file));
}

const frontendFiles = [
  ...existingFiles(["index.html", "webstore.config.js"]),
  ...assetFiles()
];
const forbidden = ["DEVOUR_API_KEY", "Bearer ", "api.devourmc", "DEVOUR_API_URL"];

for (const file of frontendFiles) {
  const content = read(file);
  for (const token of forbidden) {
    if (content.includes(token)) {
      console.error(`${file}: forbidden frontend token found: ${token}`);
      process.exitCode = 1;
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Static build verification passed.");
