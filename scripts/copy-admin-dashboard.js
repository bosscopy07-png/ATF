const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "..", "src", "admin", "dashboard.html");
const destinationDir = path.resolve(__dirname, "..", "dist", "admin");
const destination = path.join(destinationDir, "dashboard.html");

if (!fs.existsSync(source)) {
  throw new Error(`Admin dashboard source file not found: ${source}`);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);

console.log(`[build] Copied admin dashboard: ${destination}`);
