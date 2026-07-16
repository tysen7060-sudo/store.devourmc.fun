"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

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

function walk(dir) {
  const full = path.join(root, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
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

const frontendFiles = ["index.html", "webstore.config.js", ...walk("images")];
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
