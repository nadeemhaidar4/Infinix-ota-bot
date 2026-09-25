const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 4;
const MAX_ACTIVE_PER_IP = 3;

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;

const rateStore = new Map();
const activeDownloads = new Map();

const allowedTypes = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",

  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",

  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

// --------------------------------------------------
// BASIC HELPERS
// --------------------------------------------------

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (n) => !Number.isInteger(n) || n < 0 || n > 255
    )
  ) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  );
}

async function isSafeHostname(hostname) {
  if (isBlockedHostname(hostname)) {
    return false;
  }

  const ipType = net.isIP(hostname);

  if (ipType === 4) {
    return !isPrivateIPv4(hostname);
  }

  if (ipType === 6) {
    const normalized = hostname.toLowerCase();

    if (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    ) {
      return false;
    }

    return true;
  }

  try {
    const addresses = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });

    if (!addresses.length) {
      return false;
    }

    for (const address of addresses) {
      if (
        address.family === 4 &&
        isPrivateIPv4(address.address)
      ) {
        return false;
      }

      if (address.family === 6) {
        const value = address.address.toLowerCase();

        if (
          value === "::1" ||
          value.startsWith("fc") ||
          value.startsWith("fd") ||
          value.startsWith("fe80:")
        ) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

function validateUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("URL is required");
  }

  if (value.length > 4000) {
    throw new Error("URL is too long");
  }

  let parsed;

  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "Only HTTP and HTTPS URLs are allowed"
    );
  }

  return parsed;
}

// --------------------------------------------------
// RATE LIMIT
// --------------------------------------------------

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  let record = rateStore.get(ip);

  if (
    !record ||
    now - record.start > RATE_WINDOW_MS
  ) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count += 1;

  rateStore.set(ip, record);

  if (record.count > RATE_LIMIT) {
    return res.status(429).json({
      ok: false,
      error:
        "Too many requests. Please try again later."
    });
  }

  next();
}

// --------------------------------------------------
// ACTIVE DOWNLOAD LIMIT
// --------------------------------------------------

function incrementActive(ip) {
  const current = activeDownloads.get(ip) || 0;

  if (current >= MAX_ACTIVE_PER_IP) {
    return false;
  }

  activeDownloads.set(ip, current + 1);

  return true;
}

function decrementActive(ip) {
  const current = activeDownloads.get(ip) || 0;

  if (current <= 1) {
    activeDownloads.delete(ip);
  } else {
    activeDownloads.set(ip, current - 1);
  }
}

// --------------------------------------------------
// TIMEOUT
// --------------------------------------------------

function createTimeout(ms) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, ms);

  return {
    controller,

    clear() {
      clearTimeout(timer);
    }
  };
}

// --------------------------------------------------
// FILENAME
// --------------------------------------------------

function filenameFromUrl(url, contentType) {
  try {
    const parsed = new URL(url);

    const parts = parsed.pathname
      .split("/")
      .filter(Boolean);

    const lastPart = parts[parts.length - 1] || "";

    const decoded = decodeURIComponent(lastPart);

    if (
      decoded &&
      /^[a-zA-Z0-9._-]+$/.test(decoded)
    ) {
      return decoded.slice(0, 150);
    }
  } catch {}

  const extensionMap = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",

    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",

    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };

  const extension =
    extensionMap[contentType] || "bin";

  return `quicksave.${extension}`;
}

// --------------------------------------------------
// CONTENT TYPE
// --------------------------------------------------

function getContentType(response) {
  return (
    response.headers.get("content-type") || ""
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
}

// --------------------------------------------------
// SAFE FETCH WITH REDIRECT PROTECTION
// --------------------------------------------------

async function fetchSafe(url, options = {}) {
  let currentUrl = url;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const parsed = validateUrl(currentUrl);

    const safe = await isSafeHostname(
      parsed.hostname
    );

    if (!safe) {
      throw new Error(
        "Blocked destination"
      );
    }

    const timeout = createTimeout(
      options.timeoutMs ||
        INSPECT_TIMEOUT_MS
    );

    try {
      const method =
        options.method || "GET";

      const response = await fetch(
        currentUrl,
        {
          method,
          redirect: "manual",
          signal: timeout.controller.signal,

          headers: {
            "User-Agent":
              "QuickSave/2.0",
            Accept: "*/*"
          }
        }
      );

      if (
        [301, 302, 303, 307, 308].includes(
          response.status
        )
      ) {
        const location =
          response.headers.get(
            "location"
          );

        if (!location) {
          throw new Error(
            "Redirect without location"
          );
        }

        currentUrl = new URL(
          location,
          currentUrl
        ).toString();

        continue;
      }

      return {
        response,
        finalUrl: currentUrl
      };
    } finally {
      timeout.clear();
    }
  }

  throw new Error(
    "Too many redirects"
  );
}

// --------------------------------------------------
// INSPECT MEDIA
// --------------------------------------------------

async function inspectMedia(url) {
  let result;

  try {
    result = await fetchSafe(
      url,
      {
        method: "HEAD",
        timeoutMs:
          INSPECT_TIMEOUT_MS
      }
    );

    if (
      result.response.status >= 400 ||
      !result.response.ok
    ) {
      throw new Error(
        "HEAD request failed"
      );
    }
  } catch {
    result = await fetchSafe(
      url,
      {
        method: "GET",
        timeoutMs:
          INSPECT_TIMEOUT_MS
      }
    );
  }

  const response =
    result.response;

  const type =
    getContentType(response);

  if (!allowedTypes.has(type)) {
    throw new Error(
      `Unsupported media type: ${
        type || "unknown"
      }`
    );
  }

  const contentLengthHeader =
    response.headers.get(
      "content-length"
    );

  let size = null;

  if (contentLengthHeader) {
    const parsedSize =
      Number(contentLengthHeader);

    if (
      Number.isFinite(parsedSize) &&
      parsedSize >= 0
    ) {
      size = parsedSize;
    }
  }

  if (
    size !== null &&
    size > MAX_BYTES
  ) {
    throw new Error(
      "File is larger than the 250 MB limit"
    );
  }

  return {
    mediaUrl: result.finalUrl,
    type,
    size,
    filename:
      filenameFromUrl(
        result.finalUrl,
        type
      )
  };
}

// --------------------------------------------------
// EXPRESS SETTINGS
// --------------------------------------------------

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "32kb"
  })
);

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get(
  "/health",
  (req, res) => {
    const active =
      Array.from(
        activeDownloads.values()
      ).reduce(
        (sum, value) =>
          sum + value,
        0
      );

    res.json({
      ok: true,
      service: "quicksave",
      uptime: Math.round(
        process.uptime()
      ),
      active
    });
  }
);

// --------------------------------------------------
// INSPECT API
// --------------------------------------------------

app.post(
  "/api/inspect",
  rateLimit,
  async (req, res) => {
    try {
      const parsed =
        validateUrl(
          req.body?.url
        );

      const safe =
        await isSafeHostname(
          parsed.hostname
        );

      if (!safe) {
        return res.status(400).json({
          ok: false,
          error:
            "This destination is not allowed."
        });
      }

      const media =
        await inspectMedia(
          parsed.toString()
        );

      return res.json({
        ok: true,
        ...media
      });
    } catch (error) {
      console.error(
        "Inspect error:",
        error.message
      );

      return res.status(400).json({
        ok: false,
        error:
          error.message ||
          "Unable to inspect this media."
      });
    }
  }
);

// --------------------------------------------------
// DOWNLOAD API
// --------------------------------------------------

app.get(
  "/api/download",
  rateLimit,
  async (req, res) => {
    const ip =
      getClientIp(req);

    if (!incrementActive(ip)) {
      return res.status(429).json({
        ok: false,
        error:
          "Too many downloads are running from this connection."
      });
    }

    let released = false;

    const release = () => {
      if (!released) {
        released = true;
        decrementActive(ip);
      }
    };

    res.on("close", release);
    res.on("finish", release);

    try {
      const parsed =
        validateUrl(
          req.query?.url
        );

      const safe =
        await isSafeHostname(
          parsed.hostname
        );

      if (!safe) {
        release();

        return res.status(400).json({
          ok: false,
          error:
            "This destination is not allowed."
        });
      }

      const result =
        await fetchSafe(
          parsed.toString(),
          {
            method: "GET",
            timeoutMs:
              DOWNLOAD_TIMEOUT_MS
          }
        );

      const upstream =
        result.response;

      if (!upstream.ok) {
        release();

        return res.status(
          upstream.status
        ).json({
          ok: false,
          error:
            `Upstream server returned ${upstream.status}`
        });
      }

      const type =
        getContentType(
          upstream
        );

      if (!allowedTypes.has(type)) {
        release();

        return res.status(415).json({
          ok: false,
          error:
            "Unsupported media type."
        });
      }

      const contentLengthHeader =
        upstream.headers.get(
          "content-length"
        );

      let expectedSize = null;

      if (contentLengthHeader) {
        const parsedSize =
          Number(
            contentLengthHeader
          );

        if (
          Number.isFinite(
            parsedSize
          ) &&
          parsedSize >= 0
        ) {
          expectedSize =
            parsedSize;
        }
      }

      if (
        expectedSize !== null &&
        expectedSize > MAX_BYTES
      ) {
        release();

        return res.status(413).json({
          ok: false,
          error:
            "File is larger than the 250 MB limit."
        });
      }

      const filename =
        filenameFromUrl(
          result.finalUrl,
          type
        );

      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        type
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(
          /"/g,
          ""
        )}"`
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      if (
        expectedSize !== null
      ) {
        res.setHeader(
          "Content-Length",
          String(expectedSize)
        );
      }

      if (!upstream.body) {
        throw new Error(
          "Upstream response has no body"
        );
      }

      const reader =
        upstream.body.getReader();

      let totalBytes = 0;

      try {
        while (true) {
          const { done, value } =
            await reader.read();

          if (done) {
            break;
          }

          totalBytes +=
            value.byteLength;

          if (
            totalBytes >
            MAX_BYTES
          ) {
            try {
              await reader.cancel();
            } catch {}

            if (!res.headersSent) {
              res.status(413).json({
                ok: false,
                error:
                  "File exceeded the 250 MB limit."
              });
            } else {
              res.destroy(
                new Error(
                  "File exceeded size limit"
                )
              );
            }

            return;
          }

          const canContinue =
            res.write(
              Buffer.from(value)
            );

          if (!canContinue) {
            await new Promise(
              (resolve) => {
                res.once(
                  "drain",
                  resolve
                );
              }
            );
          }
        }

        res.end();
      } catch (streamError) {
        console.error(
          "Download stream error:",
          streamError.message
        );

        if (!res.destroyed) {
          res.destroy(
            streamError
          );
        }
      }
    } catch (error) {
      console.error(
        "Download error:",
        error.message
      );

      if (!res.headersSent) {
        res.status(400).json({
          ok: false,
          error:
            error.message ||
            "Unable to download this media."
        });
      } else if (
        !res.destroyed
      ) {
        res.destroy(error);
      }
    } finally {
      release();
    }
  }
);

// --------------------------------------------------
// STATIC WEBSITE
// --------------------------------------------------

const publicDir =
  path.join(
    __dirname,
    "public"
  );

app.use(
  express.static(
    publicDir,
    {
      extensions: ["html"]
    }
  )
);

// --------------------------------------------------
// EXPRESS 5 SAFE FALLBACK
// IMPORTANT: DO NOT USE app.get("*")
// --------------------------------------------------

app.use(
  (req, res) => {
    res.sendFile(
      path.join(
        publicDir,
        "index.html"
      )
    );
  }
);

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Express error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        "Internal server error"
    });
  }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `QuickSave server running on port ${PORT}`
      );
    }
  );

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

function shutdown(signal) {
  console.log(
    `${signal} received. Shutting down...`
  );

  server.close(() => {
    console.log(
      "Server closed."
    );

    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "Forced shutdown."
    );

    process.exit(1);
  }, 10000).unref();
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

// --------------------------------------------------
// ERROR PROTECTION
// --------------------------------------------------

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "Unhandled rejection:",
      reason
    );
  }
);
