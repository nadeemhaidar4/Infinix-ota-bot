const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT = 15000;
const DOWNLOAD_TIMEOUT = 60000;
const MAX_REDIRECTS = 4;

const MAX_ACTIVE_PER_IP = 3;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;

const PUBLIC_DIR = path.join(__dirname, "public");

const ALLOWED_MIME = new Set([
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

const rateMap = new Map();
const activeMap = new Map();

app.use(express.json({ limit: "100kb" }));

function cleanIp(ip) {
  if (!ip) return "unknown";

  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }

  if (ip.startsWith("::ffff:")) {
    ip = ip.substring(7);
  }

  return ip;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase();

  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

async function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host === "metadata.google.internal"
  ) {
    return true;
  }

  const type = net.isIP(host);

  if (type === 4) {
    return isPrivateIPv4(host);
  }

  if (type === 6) {
    return isPrivateIPv6(host);
  }

  try {
    const records = await dns.lookup(host, {
      all: true,
      verbatim: true
    });

    for (const record of records) {
      if (record.family === 4 && isPrivateIPv4(record.address)) {
        return true;
      }

      if (record.family === 6 && isPrivateIPv6(record.address)) {
        return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}

async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("URL is required.");
  }

  let url;

  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Please enter a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (await isBlockedHost(url.hostname)) {
    throw new Error("This URL cannot be accessed safely.");
  }

  return url;
}

function checkRateLimit(ip) {
  const now = Date.now();

  let record = rateMap.get(ip);

  if (!record || now - record.start > RATE_WINDOW) {
    record = {
      start: now,
      count: 0
    };

    rateMap.set(ip, record);
  }

  record.count++;

  return record.count <= RATE_LIMIT;
}

function acquireDownload(ip) {
  const count = activeMap.get(ip) || 0;

  if (count >= MAX_ACTIVE_PER_IP) {
    return false;
  }

  activeMap.set(ip, count + 1);
  return true;
}

function releaseDownload(ip) {
  const count = activeMap.get(ip) || 0;

  if (count <= 1) {
    activeMap.delete(ip);
  } else {
    activeMap.set(ip, count - 1);
  }
}

function filenameFromUrl(url, contentType = "") {
  let name = "";

  try {
    name = decodeURIComponent(
      path.basename(new URL(url).pathname)
    );
  } catch {}

  name = name.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (!name || name === "." || name.length < 2) {
    if (contentType.startsWith("video/")) {
      return "quicksave-video.mp4";
    }

    if (contentType.startsWith("audio/")) {
      return "quicksave-audio";
    }

    return "quicksave-media";
  }

  return name.slice(0, 180);
}

function getContentType(response) {
  return (
    response.headers.get("content-type") ||
    ""
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
}

async function fetchSafe(
  initialUrl,
  options = {},
  redirectCount = 0
) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error("Too many redirects.");
  }

  const url = await validateUrl(initialUrl);

  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: {
      "User-Agent": "QuickSave/2.1",
      "Accept": "*/*",
      ...(options.headers || {})
    },
    signal: options.signal
  });

  if (
    [301, 302, 303, 307, 308].includes(response.status)
  ) {
    const location = response.headers.get("location");

    if (!location) {
      throw new Error("Redirect location missing.");
    }

    const nextUrl = new URL(location, url).toString();

    return fetchSafe(
      nextUrl,
      options,
      redirectCount + 1
    );
  }

  return response;
}

async function inspectMedia(rawUrl) {
  const url = await validateUrl(rawUrl);
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, INSPECT_TIMEOUT);

  try {
    let response;

    try {
      response = await fetchSafe(url.toString(), {
        method: "HEAD",
        signal: controller.signal
      });
    } catch {
      response = null;
    }

    let contentType = response
      ? getContentType(response)
      : "";

    let contentLength = response
      ? Number(
          response.headers.get("content-length") || 0
        )
      : 0;

    /*
     * Some servers don't support HEAD.
     * Try a tiny GET instead.
     */
    if (
      !response ||
      !response.ok ||
      !contentType
    ) {
      response = await fetchSafe(url.toString(), {
        method: "GET",
        headers: {
          Range: "bytes=0-0"
        },
        signal: controller.signal
      });

      contentType = getContentType(response);

      contentLength = Number(
        response.headers.get("content-length") || 0
      );

      try {
        await response.body?.cancel();
      } catch {}
    }

    if (!response.ok) {
      return {
        ok: false,
        type: "error",
        message:
          `The server returned HTTP ${response.status}.`
      };
    }

    if (!ALLOWED_MIME.has(contentType)) {
      return {
        ok: false,
        type: "unsupported",
        contentType,
        message:
          "This URL does not point to a supported public media file. Ensure it's a direct link to a video/audio."
      };
    }

    if (
      contentLength &&
      contentLength > MAX_BYTES
    ) {
      return {
        ok: false,
        type: "too-large",
        message:
          "This media file is larger than the 250 MB limit."
      };
    }

    return {
      ok: true,
      type: "media",
      url: url.toString(),
      contentType,
      size: contentLength || null,
      filename: filenameFromUrl(
        url.toString(),
        contentType
      )
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "QuickSave",
    version: "2.1"
  });
});

app.post("/api/inspect", async (req, res) => {
  const ip = cleanIp(
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress
  );

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      ok: false,
      message:
        "Too many requests. Please wait a moment and try again."
    });
  }

  try {
    const result = await inspectMedia(req.body?.url);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error("Inspect error:", error);

    return res.status(400).json({
      ok: false,
      type: "error",
      message:
        error.message ||
        "Unable to process this URL."
    });
  }
});

app.get("/api/download", async (req, res) => {
  const ip = cleanIp(
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress
  );

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      ok: false,
      message:
        "Too many requests. Please wait a moment and try again."
    });
  }

  if (!acquireDownload(ip)) {
    return res.status(429).json({
      ok: false,
      message:
        "Too many downloads are running from this connection. Please wait."
    });
  }

  try {
    const rawUrl = req.query.url;
    const url = await validateUrl(rawUrl);
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT);

    try {
      const response = await fetchSafe(
        url.toString(),
        {
          method: "GET",
          signal: controller.signal
        }
      );

      if (!response.ok) {
        return res.status(400).json({
          ok: false,
          message:
            `Media server returned HTTP ${response.status}.`
        });
      }

      const contentType = getContentType(response);

      if (!ALLOWED_MIME.has(contentType)) {
        return res.status(400).json({
          ok: false,
          message:
            "The URL does not point to supported media."
        });
      }

      const contentLength = Number(
        response.headers.get("content-length") || 0
      );

      if (
        contentLength &&
        contentLength > MAX_BYTES
      ) {
        return res.status(413).json({
          ok: false,
          message:
            "This file is larger than the 250 MB limit."
        });
      }

      const filename = filenameFromUrl(
        url.toString(),
        contentType
      );

      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        contentType
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

      if (contentLength) {
        res.setHeader(
          "Content-Length",
          String(contentLength)
        );
      }

      let total = 0;

      if (!response.body) {
        throw new Error(
          "Media stream unavailable."
        );
      }

      for await (const chunk of response.body) {
        total += chunk.length;

        if (total > MAX_BYTES) {
          controller.abort();

          if (!res.headersSent) {
            return res.status(413).json({
              ok: false,
              message:
                "Download exceeded the 250 MB limit."
            });
          }

          res.destroy();
          return;
        }

        if (!res.write(chunk)) {
          await new Promise((resolve) =>
            res.once("drain", resolve)
          );
        }
      }

      res.end();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Download error:", error);

    if (!res.headersSent) {
      return res.status(400).json({
        ok: false,
        message:
          error.name === "AbortError"
            ? "Download timed out."
            : error.message ||
              "Unable to download this media."
      });
    }

    res.destroy();
  } finally {
    releaseDownload(ip);
  }
});

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ["html"]
  })
);

app.use((req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    ok: false,
    message: "Internal server error."
  });
});

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `QuickSave running on port ${PORT}`
    );
  }
);

function shutdown(signal) {
  console.log(
    `${signal} received. Shutting down...`
  );

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () =>
  shutdown("SIGTERM")
);

process.on("SIGINT", () =>
  shutdown("SIGINT")
);

process.on("uncaughtException", (error) => {
  console.error(
    "Uncaught exception:",
    error
  );
});

process.on("unhandledRejection", (error) => {
  console.error(
    "Unhandled rejection:",
    error
  );
});
