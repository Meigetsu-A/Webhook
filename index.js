const http   = require("http");
const crypto = require("crypto");
const https  = require("https");

const SECRET              = process.env.GITHUB_WEBHOOK_SECRET || "";
const PORT                = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

function verifySignature(payload, signature) {
  if (!SECRET || !signature) return true;
  const hmac   = crypto.createHmac("sha256", SECRET);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString("en-US", {
    month:  "short",
    day:    "numeric",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

function getDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  const s  = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function stepIcon(status, conclusion) {
  if (status === "in_progress") return "🔄";
  if (status === "queued")      return "⏳";
  if (conclusion === "success") return "✅";
  if (conclusion === "failure") return "❌";
  if (conclusion === "skipped") return "⏭️";
  return "❓";
}

function embedColor(conclusion, status) {
  if (conclusion === "success")   return 0x2ecc71; // green
  if (conclusion === "failure")   return 0xe74c3c; // red
  if (conclusion === "cancelled") return 0xf39c12; // orange
  if (status === "in_progress")   return 0x3498db; // blue
  return 0x95a5a6;                                  // gray
}

function buildEmbed(repo, jobName, status, conclusion, date, steps) {
  const label = conclusion || status;
  const totalDuration = steps.length > 0
    ? getDuration(
        steps.find(s => s.started_at)?.started_at,
        [...steps].reverse().find(s => s.completed_at)?.completed_at
      )
    : null;

  const stepLines = steps.map(step => {
    const icon = stepIcon(step.status, step.conclusion);
    const dur  = getDuration(step.started_at, step.completed_at);
    return `- ${icon} ${step.name}${dur ? `  \`${dur}\`` : ""}`;
  }).join("\n");

  return {
    embeds: [{
      title: `${repo}`,
      color: embedColor(conclusion, status),
      fields: [
        {
          name: "Job",
          value: jobName,
          inline: true,
        },
        {
          name: "Status",
          value: `${label}${totalDuration ? ` · \`${totalDuration}\`` : ""}`,
          inline: true,
        },
        {
          name: "Date",
          value: date,
          inline: true,
        },
        ...(stepLines ? [{
          name: "Steps",
          value: stepLines,
          inline: false,
        }] : []),
      ],
    }],
  };
}

function sendToDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("DISCORD_WEBHOOK_URL not set:", JSON.stringify(payload, null, 2));
    return;
  }

  const body = JSON.stringify(payload);
  const url  = new URL(DISCORD_WEBHOOK_URL);

  const options = {
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   "POST",
    headers:  {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode >= 400) {
      console.error(`Discord webhook error: ${res.statusCode}`);
    }
  });
  req.on("error", (err) => console.error("Discord request failed:", err.message));
  req.write(body);
  req.end();
}

// ── HTTP server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    return res.end("Not Found");
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(body, sig)) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }

    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); return res.end("Bad Request"); }

    const event = req.headers["x-github-event"];
    const repo  = payload.repository?.full_name ?? "unknown/repo";

    if (event === "workflow_job") {
      const job    = payload.workflow_job;
      const steps  = job.steps ?? [];
      const date   = formatDate(job.completed_at || job.started_at);
      const embed  = buildEmbed(repo, job.name, job.status, job.conclusion, date, steps);
      sendToDiscord(embed);

    } else if (event === "workflow_run") {
      const run   = payload.workflow_run;
      const date  = formatDate(run.updated_at || run.created_at);
      const embed = buildEmbed(repo, run.name, run.status, run.conclusion, date, []);
      sendToDiscord(embed);
    }

    res.writeHead(200);
    res.end("OK");
  });
});

server.listen(PORT, () => {
  console.log(`GitHub webhook listening on :${PORT}/webhook`);
});
