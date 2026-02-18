require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`[GitHub Webhook] Received event: ${event}`);

  // Only process workflow_run events
  if (event !== 'workflow_run') {
    return res.status(200).json({ message: 'Event ignored' });
  }

  const workflow = payload.workflow_run;
  const conclusion = workflow.conclusion;
  const workflowName = workflow.name;
  const branch = workflow.head_branch;
  const runUrl = workflow.html_url;
  const actor = workflow.actor.login;
  const completedAt = new Date(workflow.completed_at);
  const jobsUrl = workflow.jobs_url;
  const headSha = workflow.head_sha;
  const repoUrl = workflow.repository.url;

  console.log(`[Build] ${workflowName} - Status: ${conclusion}`);

  // Fetch job details to get check runs and their results
  let checkDetails = await fetchCheckRunDetails(jobsUrl);

  // Fetch commit statistics for lines added and deleted
  let commitStats = await fetchCommitStats(repoUrl, headSha);

  // Send to Discord
  await sendToDiscord({
    status: conclusion,
    workflowName,
    branch,
    runUrl,
    actor,
    completedAt,
    checkDetails,
    commitStats
  });

  res.status(200).json({ message: 'Webhook processed' });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ message: 'GitHub APK Webhook is running' });
});

async function fetchCommitStats(repoUrl, sha) {
  try {
    const commitUrl = `${repoUrl}/commits/${sha}`;
    const response = await fetch(commitUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      console.error('[GitHub API] Failed to fetch commit stats');
      return null;
    }

    const commitData = await response.json();
    const files = commitData.files || [];
    
    let filesAdded = 0;
    let filesModified = 0;
    let filesDeleted = 0;

    files.forEach(file => {
      if (file.status === 'added') {
        filesAdded++;
      } else if (file.status === 'modified') {
        filesModified++;
      } else if (file.status === 'deleted') {
        filesDeleted++;
      }
    });
    
    return {
      additions: commitData.stats?.additions || 0,
      deletions: commitData.stats?.deletions || 0,
      total: (commitData.stats?.additions || 0) + (commitData.stats?.deletions || 0),
      filesAdded: filesAdded,
      filesModified: filesModified,
      filesDeleted: filesDeleted,
      filesTotal: files.length
    };
  } catch (error) {
    console.error('[GitHub API] Error fetching commit stats:', error.message);
    return null;
  }
}

async function fetchCheckRunDetails(jobsUrl) {
  try {
    const response = await fetch(jobsUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      console.error('[GitHub API] Failed to fetch jobs');
      return null;
    }

    const jobsData = await response.json();
    const jobs = jobsData.jobs || [];

    let passedCount = 0;
    let failedCount = 0;
    let failedTests = [];

    jobs.forEach(job => {
      const steps = job.steps || [];
      
      steps.forEach(step => {
        if (step.conclusion === 'success') {
          passedCount++;
        } else if (step.conclusion === 'failure') {
          failedCount++;
          // Extract test name from step name
          failedTests.push(step.name);
        }
      });
    });

    return {
      passed: passedCount,
      failed: failedCount,
      failedTests: failedTests,
      total: passedCount + failedCount
    };
  } catch (error) {
    console.error('[GitHub API] Error fetching check details:', error.message);
    return null;
  }
}

async function sendToDiscord({ status, workflowName, branch, runUrl, actor, completedAt, checkDetails, commitStats }) {
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    console.error('[Discord] ERROR: DISCORD_WEBHOOK_URL not configured');
    return;
  }

  // Determine color and emoji based on status
  let color, emoji, statusText;
  
  if (status === 'success') {
    color = 3066993; // Green
    emoji = '✅';
    statusText = 'BUILD SUCCESSFUL';
  } else if (status === 'failure') {
    color = 15158332; // Red
    emoji = '❌';
    statusText = 'BUILD FAILED';
  } else if (status === 'cancelled') {
    color = 9807270; // Gray
    emoji = '⏹️';
    statusText = 'BUILD CANCELLED';
  } else {
    color = 9807270;
    emoji = '⚠️';
    statusText = status.toUpperCase();
  }

  // Build fields array
  const fields = [
    {
      name: 'Status',
      value: `**${statusText}**`,
      inline: true
    }
  ];

  // Add check results if available
  if (checkDetails && checkDetails.total > 0) {
    const checkText = `✅ ${checkDetails.passed} / ${checkDetails.total} checks passed`;
    fields.push({
      name: 'Checks',
      value: checkText,
      inline: false
    });

    // Add failed tests if any
    if (checkDetails.failedTests && checkDetails.failedTests.length > 0) {
      const failedList = checkDetails.failedTests
        .map(test => `❌ ${test}`)
        .join('\n');
      
      fields.push({
        name: 'Failed Tests',
        value: failedList,
        inline: false
      });
    }
  }

  // Add commit statistics if available
  if (commitStats) {
    const statsText = `➕ ${commitStats.additions} additions\n➖ ${commitStats.deletions} deletions`;
    fields.push({
      name: 'Lines Changed',
      value: statsText,
      inline: false
    });

    // Add files changed information
    const filesText = `📄 ${commitStats.filesAdded} added\n✏️ ${commitStats.filesModified} modified\n🗑️ ${commitStats.filesDeleted} deleted`;
    fields.push({
      name: 'Files Changed',
      value: filesText,
      inline: false
    });
  }

  // Create the Discord embed message
  const discordMessage = {
    embeds: [
      {
        title: `${emoji} ${workflowName}`,
        color: color,
        fields: fields,
        footer: {
          text: 'GitHub Actions APK Builder'
        }
      }
    ]
  };

  try {
    const response = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(discordMessage)
    });

    if (!response.ok) {
      console.error(`[Discord] ERROR: Failed to send message (Status: ${response.status})`);
    } else {
      console.log('[Discord] ✅ Notification sent successfully');
    }
  } catch (error) {
    console.error('[Discord] ERROR:', error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
  console.log(`📍 Webhook URL: http://localhost:${PORT}/webhook`);
});
