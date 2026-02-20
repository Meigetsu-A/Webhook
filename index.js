const http = require("http");
const https = require("https");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

function sendDiscordEmbed(embed) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ embeds: [embed] });
    const url = new URL(DISCORD_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", resolve);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

async function handleWorkflowRun(payload) {
  const run = payload.workflow_run;
  if (!run) return;

  const status = run.conclusion; // success, failure, cancelled, etc.
  const failed = status !== "success" && status !== null;
  const isPending = status === null;

  if (isPending) return; // Only fire when complete

  // Gather failed jobs info if failed
  let failedJobsText = "";
  let locAdded = 0;
  let filesChanged = 0;
  let fileLOCLines = [];

  // Try to get jobs data from the jobs_url
  if (failed && run.jobs_url) {
    try {
      const jobsData = await fetchJSON(run.jobs_url + "?per_page=100");
      const failedJobs = (jobsData.jobs || []).filter(
        (j) => j.conclusion === "failure"
      );

      if (failedJobs.length > 0) {
        failedJobsText = failedJobs
          .map((job) => {
            const failedSteps = job.steps
              .filter((s) => s.conclusion === "failure")
              .map((s) => `    ↳ Step: **${s.name}**`)
              .join("\n");
            return `❌ **${job.name}**\n${failedSteps || "    ↳ Unknown step"}`;
          })
          .join("\n\n");
      }
    } catch (e) {
      failedJobsText = "Could not retrieve job details.";
    }
  }

  // Get commit LOC stats via GitHub compare API
  // run.head_sha is the commit sha
  if (run.repository && run.head_sha) {
    try {
      const repoFullName = run.repository.full_name;
      const sha = run.head_sha;
      const commitData = await fetchJSON(
        `https://api.github.com/repos/${repoFullName}/commits/${sha}`
      );

      if (commitData.stats) {
        locAdded = commitData.stats.additions || 0;
      }

      if (commitData.files && commitData.files.length > 0) {
        filesChanged = commitData.files.length;
        fileLOCLines = commitData.files.map((f) => {
          const name = f.filename.split("/").pop();
          return `\`${name}\` — +${f.additions} / -${f.deletions} (${f.changes} changes)`;
        });
      }
    } catch (e) {
      // Stats unavailable
    }
  }

  const color = failed ? 0xe74c3c : 0x2ecc71;
  const statusLabel = failed
    ? `❌ FAILED (${status})`
    : "✅ PASSED";

  const fields = [
    {
      name: "🔁 Workflow",
      value: `\`${run.name}\``,
      inline: true,
    },
    {
      name: "📊 Status",
      value: statusLabel,
      inline: true,
    },
  ];

  if (failed && failedJobsText) {
    fields.push({
      name: "💥 Failed Jobs & Steps",
      value: failedJobsText.slice(0, 1024),
      inline: false,
    });
  }

  fields.push({
    name: "📝 Lines Added (this commit)",
    value: `**+${locAdded}** lines`,
    inline: true,
  });

  fields.push({
    name: "📁 Files Changed",
    value: `**${filesChanged}** file${filesChanged !== 1 ? "s" : ""}`,
    inline: true,
  });

  if (fileLOCLines.length > 0) {
    const locSummary = fileLOCLines.join("\n").slice(0, 1024);
    fields.push({
      name: "📂 File Breakdown (LOC)",
      value: locSummary,
      inline: false,
    });
  }

  const embed = {
    title: failed
      ? "🚨 GitHub Actions — Build Failed"
      : "✅ GitHub Actions — Build Passed",
    color,
    fields,
    footer: {
      text: `Run #${run.run_number} • ${new Date(run.updated_at).toUTCString()}`,
    },
  };

  await sendDiscordEmbed(embed);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": "webhook-bot",
        Accept: "application/vnd.github+json",
      },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("JSON parse error"));
        }
      });
    }).on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end("Method Not Allowed");
  }

  const event = req.headers["x-github-event"];

  try {
    const payload = await parseBody(req);

    if (event === "workflow_run") {
      await handleWorkflowRun(payload);
      res.writeHead(200);
      res.end("OK");
    } else {
      res.writeHead(200);
      res.end("Ignored");
    }
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
