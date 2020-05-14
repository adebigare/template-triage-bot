// =============================
// === External dependencies ===
// =============================

// Official Slack packages: Bolt for Javascript & OAuth helpers
const { App, ExpressReceiver } = require('@slack/bolt')
const { InstallProvider } = require('@slack/oauth')

// Our `helpers/db.js` file defines our database connection (powered by Mongoose)
const { AuthedTeam } = require('./helpers/db')

// We'll user randomstring to generate, well, random strings for our state store
const { generate: randomStringGenerator } = require('randomstring')

// =====================================
// === Internal dependencies/helpers ===
// =====================================
const triageConfig = require('./config')
const modalViews = require('./views/modals.blockkit')
const registerOAuthRoutes = require('./helpers/routes_oauth')
const appHomeView = require('./views/app_home.blockkit')
const { getAllMessagesForPastHours, filterAndEnrichMessages, messagesToCsv } = require('./helpers/messages')
const { scheduleReminders, manuallyTriggerScheduledJobs } = require('./helpers/scheduled_jobs')

// ====================================
// === Initialization/Configuration ===
// ====================================

// Create our own instance of the ExpressReceiver, which initializes an Express app
const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
})
const expressApp = expressReceiver.app

// Initialize slackInstaller OAuth helper from @slack/oauth package
// (refer to https://github.com/slackapi/node-slack-sdk/tree/master/packages/oauth)
const slackInstaller = new InstallProvider({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  authVersion: 'v2',
  stateSecret: randomStringGenerator(),
  installationStore: {
    storeInstallation: async installation => {
      // Create a teamData object with all the `installation` data but with id and name at the top level
      let teamData = installation.team
      teamData = Object.assign(teamData, installation)
      delete teamData.team // we already have this information from the assign above
      delete teamData.user.token // we dont want a user token, if the scopes are requested

      // Do an upsert so that we always have just one document per team ID
      await AuthedTeam.findOneAndUpdate({ id: teamData.id }, teamData, { upsert: true })

      return true
    },
    fetchInstallation: async installQuery => {
      const team = await AuthedTeam.findOne({ id: installQuery.teamId })
      return team._doc
    }
  }
})

// Initialize the Bolt app
// (refer to https://github.com/slackapi/bolt)
// (notice that we don't need to pass the signing secret here- it's part of the expressReceiver instead)
const app = new App({
  receiver: expressReceiver,
  logLevel: 'DEBUG',
  authorize: async ({
    teamId
  }) => {
    try {
      const authorizeData = await slackInstaller.authorize({ teamId: teamId })
      return authorizeData
    } catch (e) {
      console.error(e)
      throw new Error('No matching authorizations.')
    }
  }
})

// ======================================================
// === Define web routes for home page and OAuth flow ===
// ======================================================
registerOAuthRoutes(expressApp, slackInstaller) // (from helpers/web_routes.js)

// =========================================================================
// === Define Slack (Bolt) handlers for Slack functionality/interactions ===
// =========================================================================

// Handle the shortcut we configured in the Slack App Config
app.shortcut('triage_stats', async ({ ack, context, body }) => {
  // Acknowledge right away
  await ack()

  // Open a modal
  await app.client.views.open({
    token: context.botToken,
    trigger_id: body.trigger_id,
    view: modalViews.select_triage_channel
  })
})

// Handle `view_submision` of modal we opened as a result of the `triage_stats` shortcut
app.view('channel_selected', async ({ body, view, ack, client, context }) => {
  // Acknowledge right away
  await ack()

  const submittedByUserId = body.user.id
  const selectedChannelId =
    view.state.values.channel.channel.selected_conversation
  const nHoursToGoBack =
    parseInt(view.state.values.n_hours.n_hours.selected_option.value) || 7

  try {
    // Get converstion info; this will throw an error if the bot does not have access to it
    const conversationInfo = await client.conversations.info({
      channel: selectedChannelId,
      include_num_members: true
    })

    // Join the conversation (necessary for reading its history)
    await client.conversations.join({
      channel: selectedChannelId
    })

    // Let the user know, in a DM from the bot, that we're working on their request
    const msgWorkingOnIt = await client.chat.postMessage({
      channel: submittedByUserId,
      text: `*You asked for triage stats for <#${selectedChannelId}>*.\n` +
        `I'll work on the stats for the past ${nHoursToGoBack} hours right away!`
    })

    // Thread a message while we get to work on the analysis
    await client.chat.postMessage({
      channel: msgWorkingOnIt.channel,
      thread_ts: msgWorkingOnIt.ts,
      text: `A number for you while you wait.. the channel has ${conversationInfo.channel.num_members} members (including apps) currently`
    })

    // Get all messages from the beginning of time (probably not a good idea)
    const allMessages = await getAllMessagesForPastHours(
      selectedChannelId,
      nHoursToGoBack,
      client
    )

    // Use the enricMessages helper to enrich the messages we have
    const allMessagesEnriched = filterAndEnrichMessages(allMessages, selectedChannelId, context.botId)

    // For each level, let's do some analysis!
    const levelDetailBlocks = []
    for (const i in triageConfig._.levels) {
      const level = triageConfig._.levels[i]
      const allMessagesForLevel = allMessagesEnriched.filter(
        m => m[`_level_${level}`] === true
      )

      // Formulate strings for each status
      const countsStrings = triageConfig._.statuses.map(status => {
        const messagesForLevelAndStatus = allMessagesForLevel.filter(
          m => m[`_status_${status}`] === true
        )
        return `\tMessages ${status} ${triageConfig._.statusToEmoji[status]}: ${messagesForLevelAndStatus.length}`
      })

      // Add level block to array
      levelDetailBlocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${triageConfig._.levelToEmoji[level]} *${level}* (${allMessagesForLevel.length} total)\n${countsStrings.join('\n')}`
          }
        }
      )
    }

    // Send a single message to the thread with all of the stats by level
    await client.chat.postMessage({
      channel: msgWorkingOnIt.channel,
      thread_ts: msgWorkingOnIt.ts,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "Here's a summary of the messages needing attention by urgency level and status:"
        }
      }].concat(levelDetailBlocks)
    })

    // Try to parse our object to CSV and upload it as an attachment
    try {
      // Convert object to CSV
      const csvString = messagesToCsv(allMessagesEnriched)

      // Upload CSV File
      await client.files.upload({
        channels: msgWorkingOnIt.channel,
        content: csvString,
        title: `All messages from the past ${nHoursToGoBack} hours`,
        filename: 'allMessages.csv',
        filetype: 'csv',
        thread_ts: msgWorkingOnIt.ts
      })
    } catch (err) {
      console.error(err)
    }
  } catch (e) {
    // Log error to console
    console.error(e)

    // Send error message to DM with the initiating user
    const msgError = await client.chat.postMessage({
      channel: submittedByUserId,
      text: ':warning: Sorry but something went wrong.'
    })

    // Add details for later debugging in thread
    await client.chat.postMessage({
      channel: submittedByUserId,
      thread_ts: msgError.ts,
      text: `Debug info:\n• selectedChannelId=${selectedChannelId}\n• submittedByUserId=${submittedByUserId}\n • nHoursToGoBack=${nHoursToGoBack}`
    })

    // Add full error message in thread
    await client.chat.postMessage({
      channel: submittedByUserId,
      thread_ts: msgError.ts,
      text: `\`\`\`${JSON.stringify(e)}\`\`\``
    })
  }
})

app.event('app_home_opened', async ({ payload, context }) => {
  const userId = payload.user

  try {
    // Call the views.publish method using the built-in WebClient
    await app.client.views.publish({
      // The token you used to initialize your app is stored in the `context` object
      token: context.botToken,
      user_id: userId,
      view: appHomeView(userId, triageConfig)
    })
  } catch (error) {
    console.error(error)
  }
})

// Handle the shortcut for triggering manually scheduled jobs;
// this should only be used for debugging (so we dont have to wait until a triggered job would normally fire)
app.shortcut('debug_manually_trigger_scheduled_jobs', async ({ ack, context, body }) => {
  // Acknowledge right away
  await ack()
  // Execute helper function to manually trigger the scheduled jobs
  manuallyTriggerScheduledJobs()
})

// Handle Bolt errors
app.error(error => {
  // Check the details of the error to handle cases where you should retry sending a message or stop the app
  console.error(error)
});

(async () => {
  // Schedule our dynamic cron jobs
  scheduleReminders()

  // Actually start thhe Bolt app. Let's go!
  await app.start(process.env.PORT || 3000)
  console.log('⚡️ Bolt app is running!')
})()