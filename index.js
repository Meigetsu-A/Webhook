export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  // Only process workflow_run events
  if (event !== 'workflow_run') {
    return res.status(200).json({ message: 'Event ignored' });
  }

  const workflow = payload.workflow_run;
  const conclusion = workflow.conclusion; // 'success' or 'failure'
  const workflowName = workflow.name;
  const branch = workflow.head_branch;
  const runUrl = workflow.html_url;
  const actor = workflow.actor.login;
  const completedAt = new Date(workflow.completed_at);

  // Send to Discord
  await sendToDiscord({
    status: conclusion,
    workflowName,
    branch,
    runUrl,
    actor,
    completedAt
  });

  res.status(200).json({ message: 'Webhook processed' });
}

async function sendToDiscord({ status, workflowName, branch, runUrl, actor, completedAt }) {
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!discordWebhookUrl) {
    console.error('Discord webhook URL not configured');
    return;
  }

  // Pick color and emoji based on status
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

  // Create the Discord message
  const discordMessage = {
    embeds: [
      {
        title: `${emoji} ${workflowName}`,
        color: color,
        fields: [
          {
            name: 'Status',
            value: `**${statusText}**`,
            inline: true
          },
          {
            name: 'Branch',
            value: branch,
            inline: true
          },
          {
            name: 'Triggered by',
            value: actor,
            inline: false
          }
        ],
        footer: {
          text: 'GitHub Actions APK Builder'
        }
      }
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            label: 'View Build',
            style: 5,
            url: runUrl
          }
        ]
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
      console.error('Failed to send Discord message:', response.status);
    }
  } catch (error) {
    console.error('Error sending Discord message:', error);
  }
    }
