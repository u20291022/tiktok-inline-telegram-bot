// Puppeteer config, read both by the install script (chromium download)
// and at runtime when resolving the browser executable.
//
// On Windows the default cache lives under the user profile
// (C:\Users\<name>\.cache\puppeteer); this machine's username breaks
// tooling that mishandles it, so pin an ASCII-only path outside the
// profile. On Linux/production keep the cache next to the project.
const path = require("path");

module.exports = {
  cacheDirectory:
    process.platform === "win32"
      ? "C:\\puppeteer-cache"
      : path.join(__dirname, ".puppeteer-cache"),
};
