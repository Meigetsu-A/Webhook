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

async function getFullBranchStats(repoFullName, sha) {
  let totalLOC = 0;
  let totalFiles = 0;

  // Walk the full git tree at this sha
  const treeData = await fetchJSON(
    `https://api.github.com/repos/${repoFullName}/git/trees/${sha}?recursive=1`
  );

  const blobs = (treeData.tree || []).filter((item) => item.type === "blob");
  totalFiles = blobs.length;

  // Count lines in each file, batched to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < blobs.length; i += batchSize) {
    const batch = blobs.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (blob) => {
        try {
          const blobData = await fetchJSON(
            `https://api.github.com/repos/${repoFullName}/git/blobs/${blob.sha}`
          );
          if (blobData.encoding === "base64" && blobData.content) {
            const content = Buffer.from(blobData.content, "base64").toString("utf8");
            totalLOC += content.split("\n").length;
          }
        } catch {
          // Skip binaries or unreadable blobs
        }
      })
    );
  }

  return { totalLOC, totalFiles };
}

async function handleWorkflowRun(payload) {
  const run = payload.workflow_run;
  if (!run) return;

  const status = run.conclusion;
  const failed = status !== "success" && status !== null;
  const isPending = status === null;

  if (isPending) return; // Only notify when run is complete

  let failedJobsText = "";
  let locAdded = 0;
  let filesChanged = 0;
  let fileLOCLines = [];
  let totalBranchLOC = 0;
  let totalBranchFiles = 0;

  const repoFullName = run.repository?.full_name;
  const sha = run.head_sha;

  // Get failed jobs and steps
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
    } catch {
      failedJobsText = "Could not retrieve job details.";
    }
  }

  if (repoFullName && sha) {
    // This commit's additions and per-file breakdown
    try {
      const commitData = await fetchJSON(
        `https://api.github.com/repos/${repoFullName}/commits/${sha}`
      );

      if (commitData.stats) {
        locAdded = commitData.stats.additions || 0;
      }

      if (commitData.files?.length > 0) {
        filesChanged = commitData.files.length;
        fileLOCLines = commitData.files.map((f) => {
          const name = f.filename.split("/").pop();
          return `\`${name}\` — +${f.additions} / -${f.deletions} (${f.changes} changes)`;
        });
      }
    } catch {
      // Unavailable
    }

    // Full branch total LOC + file count
    try {
      const stats = await getFullBranchStats(repoFullName, sha);
      totalBranchLOC = stats.totalLOC;
      totalBranchFiles = stats.totalFiles;
    } catch {
      // Unavailable
    }
  }

  const color = failed ? 0xe74c3c : 0x2ecc71;
  const statusLabel = failed ? `❌ FAILED (${status})` : "✅ PASSED";

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

  // This commit stats
  fields.push({
    name: "📝 Lines Added (this commit)",
    value: `**+${locAdded.toLocaleString()}** lines`,
    inline: true,
  });

  fields.push({
    name: "📁 Files Changed (this commit)",
    value: `**${filesChanged}** file${filesChanged !== 1 ? "s" : ""}`,
    inline: true,
  });

  if (fileLOCLines.length > 0) {
    // Split file list into multiple fields to respect Discord's 1024 char limit per field
    const chunks = [];
    let current = "";
    for (const line of fileLOCLines) {
      const next = current ? current + "\n" + line : line;
      if (next.length > 1024) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);

    // Discord allows max 25 fields total, leave room for other fields
    const maxChunks = Math.min(chunks.length, 25 - fields.length - 2);
    chunks.slice(0, maxChunks).forEach((chunk, i) => {
      fields.push({
        name: i === 0
          ? "📂 File Breakdown (this commit)"
          : `📂 File Breakdown (cont. ${i + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }

  // Full branch totals
  fields.push({
    name: "🗂️ Total Files in Branch",
    value: `**${totalBranchFiles.toLocaleString()}** files`,
    inline: true,
  });

  fields.push({
    name: "📏 Total LOC in Branch",
    value: `**${totalBranchLOC.toLocaleString()}** lines`,
    inline: true,
  });

  const embed = {
    title: failed
      ? "🚨 GitHub Actions — Build Failed"
      : "✅ GitHub Actions — Build Passed",
    color,
    fields,
    footer: {
      text: `Run #${run.run_number}`,
    },
  };

  await sendDiscordEmbed(embed);
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
