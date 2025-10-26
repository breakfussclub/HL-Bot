// Higher-er Podcast v1.js — Tier 1 + Tier 2 + In-message controls + SR1 tagging
//
// ENV (Railway):
// DISCORD_TOKEN=...           (bot token)
// APP_ID=...                  (application/bot ID)
// GUILD_ID=...                (your Discord server ID)
// VOICE_CHANNEL_ID=...        (voice channel to join)
// RSS_URL=...                 (podcast RSS feed URL)
// ANNOUNCE_CHANNEL_ID=...     (text channel to post "Now Playing" embeds; optional)
//
// Notes:
// - Commands auto-register to BOTH guild and global on startup (hard sync).
// - Now Playing embed posts ONLY when a NEW episode begins (not on mid-episode resume).
// - Buttons appear under that embed: [⏯ Pause/Resume] [⏭ Skip] [🔁 Restart].
// - Only users IN THE SAME VOICE CHANNEL may press the buttons (Option 2).
// - SR1 tagging: tag ONLY when auto-resuming from empty VC; not on manual actions or first boot start.

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Partials,
  Events,
  REST,
  Routes,
  PermissionsBitField,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType,
} from '@discordjs/voice';
import Parser from 'rss-parser';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import sodium from 'libsodium-wrappers';
import axios from 'axios';

// ─────────────────────────── ENV ───────────────────────────
const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID,
  VOICE_CHANNEL_ID,
  RSS_URL,
  ANNOUNCE_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !RSS_URL || !APP_ID) {
  console.error('❌ Missing env. Require: DISCORD_TOKEN, APP_ID, VOICE_CHANNEL_ID, RSS_URL');
  process.exit(1);
}

// ─────────────────────── Config ───────────────────────
const REFRESH_RSS_MS = 60 * 60 * 1000;
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;

const OPUS_BITRATE = '96k';
const OPUS_CHANNELS = '2';
const OPUS_APP = 'audio';

const FETCH_UA = 'Mozilla/5.0 (PodcastPlayer/1.0; +https://discord.com)';
const FETCH_ACCEPT = 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8';

const STARTUP_WATCHDOG_MS = 45000;
const RESUME_RESTART_THRESHOLD_MS = 300000; // 5 minutes

// ───────────────────── Discord Client ─────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});

// ───────────────────── Presence ─────────────────────
function cleanTitleForStatus(title) {
  if (!title) return 'Podcast';
  return String(title)
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || 'Podcast';
}
function setListeningStatus(title) {
  try { client.user?.setActivity(cleanTitleForStatus(title), { type: 2 }); } catch {}
}

// ───────────────────── RSS Fetch ─────────────────────
const parser = new Parser({ headers: { 'User-Agent': 'discord-podcast-radio/1.0' } });
let episodes = [];
let episodeIndex = 0;

async function fetchEpisodes() {
  try {
    const feed = await parser.parseURL(RSS_URL);
    const items = (feed.items || [])
      .map((it) => {
        const url = it?.enclosure?.url || it?.link || it?.guid;
        const desc = it?.contentSnippet || it?.content || it?.summary || '';
        return {
          title: it?.title || 'Untitled',
          url,
          pubDate: it?.pubDate ? new Date(it.pubDate).getTime() : 0,
          link: it?.link || url || null,
          description: String(desc || '').replace(/\s+/g, ' ').trim(),
        };
      })
      .filter(x => typeof x.url === 'string' && x.url.startsWith('http'));

    items.sort((a, b) => a.pubDate - b.pubDate);
    if (items.length) {
      episodes = items;
      console.log(`📻 RSS Loaded: ${episodes.length} episodes`);
    }
  } catch (err) {
    console.error('❌ RSS fetch failed:', err?.message || err);
  }
}

// ───────────────────── Streaming Layer ─────────────────────
function inferInputFormat(contentType = '') {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpeg')) return 'mp3';
  if (ct.includes('x-m4a') || ct.includes('mp4') || ct.includes('aac')) return 'mp4';
  return null;
}

async function axiosStream(url) {
  return axios.get(url, {
    responseType: 'stream',
    maxRedirects: 5,
    headers: { 'User-Agent': FETCH_UA, 'Accept': FETCH_ACCEPT, 'Range': 'bytes=0-' },
    timeout: 60000,
  });
}

function spawnFfmpegFromStream(stream, fmt, offsetMs = 0) {
  const skipSec = Math.floor(offsetMs / 1000).toString();

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', 'file,http,https,tcp,tls,pipe',
    '-ss', skipSec,
    ...(fmt ? ['-f', fmt] : []),
    '-i', 'pipe:0',
    '-vn',
    '-ac', OPUS_CHANNELS,
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,
    '-application', OPUS_APP,
    '-f', 'ogg',
    'pipe:1',
  ];

  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  stream.on('error', () => {});
  stream.pipe(child.stdin);
  child.stdin.on('error', () => {});

  return child;
}

// ───────────────────── Playback State ─────────────────────
let hasStartedPlayback = false;
let isPausedDueToEmpty = false;
let resumeOffsetMs = 0;
let startedAtMs = 0;
let ffmpegProc = null;
let currentEpisode = null;
let playLock = false;

// Announcements + Controls
let announceChannel = null;
let lastAnnouncedEpisodeIdx = -1; // to avoid reposts on resume
let lastNowPlayingMessage = null; // { channelId, messageId }

// SR1 tagging
let pendingStarterUserId = null; // set only when resuming from empty VC
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:` : '') + `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// ───────────────────── Controls Row (buttons) ─────────────────────
const BTN_IDS = {
  PAUSE: 'ctl_pause',
  RESUME: 'ctl_resume',
  SKIP: 'ctl_skip',
  RESTART: 'ctl_restart',
};

function buildControlsRow(isPaused) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(isPaused ? BTN_IDS.RESUME : BTN_IDS.PAUSE)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setEmoji(isPaused ? '▶️' : '⏯'),
    new ButtonBuilder()
      .setCustomId(BTN_IDS.SKIP)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Skip')
      .setEmoji('⏭'),
    new ButtonBuilder()
      .setCustomId(BTN_IDS.RESTART)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Restart')
      .setEmoji('🔁'),
  );
  return row;
}

// ───────────────────── Announcements (Tier 2 + buttons + SR1 tag) ─────────────────────
function buildEpisodeEmbed(ep, index, total, starterUserId = null) {
  const published = ep.pubDate ? new Date(ep.pubDate).toLocaleString() : 'Unknown';
  const desc = (ep.description || '').slice(0, 300);
  const embed = new EmbedBuilder()
    .setColor(0x2b6cb0)
    .setTitle(`📻 Now Playing: ${ep.title}`)
    .setDescription(desc ? `${desc}${ep.description.length > 300 ? '…' : ''}` : 'No description provided.')
    .addFields(
      { name: 'Episode', value: `${index + 1} of ${total}`, inline: true },
      { name: 'Published', value: published, inline: true },
    )
    .setFooter({ text: 'Podcast Radio' });

  if (starterUserId) {
    embed.addFields({ name: 'Started by', value: `<@${starterUserId}>`, inline: false });
  }

  const rows = [];
  if (ep.link || ep.url) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Open Episode')
          .setStyle(ButtonStyle.Link)
          .setURL(ep.link || ep.url),
      )
    );
  }
  // Controls row (playing state by default)
  rows.push(buildControlsRow(false));
  return { embed, components: rows };
}

async function announceEpisodeStart(ep, idx, total, starterUserId = null) {
  if (!announceChannel) return;
  try {
    const { embed, components } = buildEpisodeEmbed(ep, idx, total, starterUserId);
    const msg = await announceChannel.send({ embeds: [embed], components });
    lastNowPlayingMessage = { channelId: announceChannel.id, messageId: msg.id };
  } catch (e) {
    console.warn('⚠️  Failed to send announcement:', e?.message || e);
  }
}

async function postResumeTagIfNeeded(epTitle) {
  if (!announceChannel || !pendingStarterUserId) return;
  try {
    await announceChannel.send(`🎧 Started by <@${pendingStarterUserId}> — ${epTitle}`);
  } catch {}
}

// Helper: update controls row (swap Pause ↔ Resume)
async function updateControlsRow(isPaused) {
  if (!lastNowPlayingMessage) return;
  try {
    const ch = await client.channels.fetch(lastNowPlayingMessage.channelId).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return;
    const msg = await ch.messages.fetch(lastNowPlayingMessage.messageId).catch(() => null);
    if (!msg) return;

    // Keep first row (Open Episode link) as-is if present, replace or append the controls row
    const newControls = buildControlsRow(isPaused);
    const existingComponents = msg.components || [];
    const otherRows = existingComponents.filter(r => !r.components?.some(c => [BTN_IDS.PAUSE, BTN_IDS.RESUME, BTN_IDS.SKIP, BTN_IDS.RESTART].includes(c.customId)));
    const rows = [...otherRows, newControls];
    await msg.edit({ components: rows });
  } catch {}
}

// ───────────────────── Main Playback ─────────────────────
async function playCurrent() {
  if (playLock) return;
  playLock = true;

  try {
    if (!episodes.length) {
      console.log('⏳ No episodes yet, retrying in 30s…');
      setTimeout(loopPlay, 30_000);
      return;
    }

    currentEpisode = episodes[episodeIndex % episodes.length];

    // We only announce on NEW episode start (not mid-episode resume)
    const isNewEpisodeStart = resumeOffsetMs === 0 && episodeIndex !== lastAnnouncedEpisodeIdx;

    console.log(`▶️  Now Playing (${episodeIndex + 1}/${episodes.length}): ${currentEpisode.title}${resumeOffsetMs ? ` (resume @ ${hms(resumeOffsetMs)})` : ''}`);
    setListeningStatus(currentEpisode.title);

    const res = await axiosStream(currentEpisode.url);
    const fmt = inferInputFormat(res.headers?.['content-type']);
    ffmpegProc = spawnFfmpegFromStream(res.data, fmt, resumeOffsetMs);

    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData && !isPausedDueToEmpty) {
        console.warn('⚠️  Startup timeout — skipping episode.');
        try { ffmpegProc?.kill('SIGKILL'); } catch {}
        resumeOffsetMs = 0;
        episodeIndex = (episodeIndex + 1) % episodes.length;
        setTimeout(loopPlay, 1000);
      }
    }, STARTUP_WATCHDOG_MS);

    ffmpegProc.stdout.once('data', async () => {
      gotData = true;
      clearTimeout(watchdog);
      startedAtMs = Date.now();
      console.log('✅ Audio stream started.');

      // Announce ONLY when a new episode begins
      if (isNewEpisodeStart) {
        lastAnnouncedEpisodeIdx = episodeIndex;
        // SR1: if we got here via auto-resume (paused due to empty VC previously),
        // include "Started by" in the announcement embed.
        const starterId = pendingStarterUserId;
        await announceEpisodeStart(currentEpisode, episodeIndex, episodes.length, starterId || null);
      } else {
        // If this is a mid-episode resume (under threshold), optionally post a one-liner tag
        if (pendingStarterUserId) {
          await postResumeTagIfNeeded(currentEpisode.title);
        }
      }

      // Clear pending starter id after we've announced or posted tag
      pendingStarterUserId = null;
    });

    const resource = createAudioResource(ffmpegProc.stdout, { inputType: StreamType.OggOpus });
    player.play(resource);
    isPausedDueToEmpty = false;

  } catch (err) {
    console.error('❌ Playback error:', err?.message || err);
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 1000);
  } finally {
    playLock = false;
  }
}

function loopPlay() {
  if (!hasStartedPlayback || isPausedDueToEmpty) return;
  playCurrent().catch(() => setTimeout(loopPlay, 2000));
}

player.on(AudioPlayerStatus.Idle, () => {
  if (!isPausedDueToEmpty) {
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 1000);
  }
});

player.on('error', (err) => {
  console.error('❌ AudioPlayer error:', err?.message || err);
  if (!isPausedDueToEmpty) {
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 1000);
  }
});

// ───────────────────── Voice Handling ─────────────────────
let connection = null;
let keepAliveInterval = null;

function startKeepAlive(conn) {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    try { conn?.configureNetworking(); } catch {}
  }, 15000);
}
function stopKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID must point to a voice channel');

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('⚠️  Voice disconnected, retrying…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        setTimeout(() => {
          try { connection?.destroy(); } catch {}
          connection = null;
          ensureConnection().catch(() => {});
        }, REJOIN_DELAY_MS);
      }
    });

    connection.subscribe(player);
    startKeepAlive(connection);
  }
}

// ───────────────────── Pause / Resume + First Listener + SR1 tagging ─────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter(m => !m.user.bot);

  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
      resumeOffsetMs += elapsed;
      isPausedDueToEmpty = true;
      try { player.pause(); } catch {}
      try { ffmpegProc?.kill('SIGKILL'); } catch {}
      ffmpegProc = null;
      console.log(`⏸️  No listeners — paused @ ${hms(resumeOffsetMs)}.`);
    }
    return;
  }

  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log('🎧 First listener joined — starting playback.');
    // SR1 says: do NOT tag initial start from boot
    loopPlay();
    return;
  }

  const overThreshold = resumeOffsetMs >= RESUME_RESTART_THRESHOLD_MS;

  if (isPausedDueToEmpty) {
    // Identify the "starter" (the joiner that triggered resume)
    const joiner = newState?.member && !newState.member.user.bot ? newState.member : humans.first();
    pendingStarterUserId = joiner ? joiner.id : null;

    if (overThreshold) {
      console.log(`🔁 Returning listener — episode played ${hms(resumeOffsetMs)}, above 5m threshold, restarting from the beginning.`);
      resumeOffsetMs = 0;
      isPausedDueToEmpty = false;
      playCurrent();
    } else {
      console.log(`▶️  Listener returned — resuming from ${hms(resumeOffsetMs)} (under threshold).`);
      isPausedDueToEmpty = false;
      playCurrent();
    }
  } else if (player.state.status === AudioPlayerStatus.Paused) {
    // Paused for another reason (manual pause). SR1: no tag here.
    if (overThreshold) {
      console.log(`🔁 Returning listener — episode played ${hms(resumeOffsetMs)}, above 5m threshold, restarting from the beginning.`);
      resumeOffsetMs = 0;
      playCurrent();
    } else {
      console.log(`▶️  Listener returned — resuming from ${hms(resumeOffsetMs)} (under threshold).`);
      playCurrent();
    }
  }
});

// ───────────────────── Slash Command Handlers (Tier 1) ─────────────────────
async function handleNowPlaying(interaction) {
  if (!currentEpisode) {
    await interaction.reply({ content: 'Nothing playing yet.', ephemeral: true });
    return;
  }
  const elapsed = (player.state.status === AudioPlayerStatus.Playing)
    ? Math.max(0, Date.now() - (startedAtMs || Date.now()))
    : 0;
  const offset = (isPausedDueToEmpty ? resumeOffsetMs : resumeOffsetMs + elapsed);
  const idx = (episodeIndex % episodes.length) + 1;
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2b6cb0)
        .setTitle(`Now Playing: ${currentEpisode.title}`)
        .setDescription(currentEpisode.description ? currentEpisode.description.slice(0, 300) + (currentEpisode.description.length > 300 ? '…' : '') : '')
        .addFields(
          { name: 'Episode', value: `${idx} of ${episodes.length}`, inline: true },
          { name: 'Position', value: hms(offset), inline: true },
        )
        .setFooter({ text: 'Podcast Radio' })
    ],
    components: (currentEpisode.link || currentEpisode.url)
      ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Open Episode').setStyle(ButtonStyle.Link).setURL(currentEpisode.link || currentEpisode.url)
        )]
      : [],
    ephemeral: true,
  });
}

async function handleSkip(interaction) {
  if (!episodes.length) return interaction.reply({ content: 'No episodes loaded.', ephemeral: true });
  resumeOffsetMs = 0;
  episodeIndex = (episodeIndex + 1) % episodes.length;
  await interaction.reply({ content: `⏭️ Skipping to episode #${(episodeIndex % episodes.length) + 1}: ${episodes[episodeIndex].title}`, ephemeral: true });
  playCurrent();
}

async function handleRestart(interaction) {
  if (!currentEpisode) return interaction.reply({ content: 'Nothing to restart.', ephemeral: true });
  resumeOffsetMs = 0;
  await interaction.reply({ content: `🔁 Restarting: ${currentEpisode.title}`, ephemeral: true });
  playCurrent();
}

async function handlePause(interaction) {
  if (player.state.status !== AudioPlayerStatus.Playing) {
    return interaction.reply({ content: 'Already paused or not playing.', ephemeral: true });
  }
  const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
  resumeOffsetMs += elapsed;
  isPausedDueToEmpty = true; // reuse same flag; we remain in VC
  try { player.pause(); } catch {}
  try { ffmpegProc?.kill('SIGKILL'); } catch {}
  ffmpegProc = null;
  await interaction.reply({ content: `⏸️ Paused @ ${hms(resumeOffsetMs)}.`, ephemeral: true });
  await updateControlsRow(true);
}

async function handleResume(interaction) {
  if (player.state.status === AudioPlayerStatus.Playing && !isPausedDueToEmpty) {
    return interaction.reply({ content: 'Already playing.', ephemeral: true });
  }
  isPausedDueToEmpty = false;
  await interaction.reply({ content: `▶️ Resuming ${currentEpisode ? currentEpisode.title : 'playback'}…`, ephemeral: true });
  playCurrent();
  await updateControlsRow(false);
}

// ───────────────────── Button Interactions (Tier 5-A) ─────────────────────
function isMemberInVoice(interaction) {
  const member = interaction.member;
  const vch = member?.voice?.channelId;
  return vch && vch === VOICE_CHANNEL_ID;
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'nowplaying': return handleNowPlaying(interaction);
        case 'skip':       return handleSkip(interaction);
        case 'restart':    return handleRestart(interaction);
        case 'pause':      return handlePause(interaction);
        case 'resume':     return handleResume(interaction);
        default: return interaction.reply({ content: 'Unknown command.', ephemeral: true });
      }
    } else if (interaction.isButton()) {
      // Only allow users in the same VC to control (Option 2)
      if (!isMemberInVoice(interaction)) {
        return interaction.reply({ content: 'You must be in the same voice channel to control playback.', ephemeral: true });
      }
      switch (interaction.customId) {
        case BTN_IDS.PAUSE: {
          if (player.state.status !== AudioPlayerStatus.Playing) return interaction.reply({ content: 'Already paused.', ephemeral: true });
          const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
          resumeOffsetMs += elapsed;
          isPausedDueToEmpty = true;
          try { player.pause(); } catch {}
          try { ffmpegProc?.kill('SIGKILL'); } catch {}
          ffmpegProc = null;
          await interaction.reply({ content: `⏸️ Paused @ ${hms(resumeOffsetMs)}.`, ephemeral: true });
          await updateControlsRow(true);
          break;
        }
        case BTN_IDS.RESUME: {
          if (player.state.status === AudioPlayerStatus.Playing && !isPausedDueToEmpty) return interaction.reply({ content: 'Already playing.', ephemeral: true });
          isPausedDueToEmpty = false;
          await interaction.reply({ content: `▶️ Resuming ${currentEpisode ? currentEpisode.title : 'playback'}…`, ephemeral: true });
          playCurrent();
          await updateControlsRow(false);
          break;
        }
        case BTN_IDS.SKIP: {
          if (!episodes.length) return interaction.reply({ content: 'No episodes loaded.', ephemeral: true });
          resumeOffsetMs = 0;
          episodeIndex = (episodeIndex + 1) % episodes.length;
          await interaction.reply({ content: `⏭️ Skipping to episode #${(episodeIndex % episodes.length) + 1}: ${episodes[episodeIndex].title}`, ephemeral: true });
          playCurrent();
          break;
        }
        case BTN_IDS.RESTART: {
          if (!currentEpisode) return interaction.reply({ content: 'Nothing to restart.', ephemeral: true });
          resumeOffsetMs = 0;
          await interaction.reply({ content: `🔁 Restarting: ${currentEpisode.title}`, ephemeral: true });
          playCurrent();
          break;
        }
        default:
          await interaction.reply({ content: 'Unknown control.', ephemeral: true });
      }
    }
  } catch (e) {
    console.error('❌ Interaction error:', e);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        try { await interaction.followUp({ content: 'Something went wrong.', ephemeral: true }); } catch {}
      } else {
        try { await interaction.reply({ content: 'Something went wrong.', ephemeral: true }); } catch {}
      }
    }
  }
});

// ───────────────────── Slash Commands: auto-register (Guild + Global, hard sync) ─────────────────────
const COMMANDS = [
  { name: 'nowplaying', description: 'Show the current episode & timestamp' },
  { name: 'skip',       description: 'Skip to the next episode' },
  { name: 'restart',    description: 'Restart the current episode' },
  { name: 'pause',      description: 'Pause playback (stays in VC)' },
  { name: 'resume',     description: 'Resume playback' },
];

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: COMMANDS });
      console.log('✅ Guild commands registered (hard sync).');
    } else {
      console.warn('⚠️  GUILD_ID not set — skipping guild command registration.');
    }
    await rest.put(Routes.applicationCommands(APP_ID), { body: COMMANDS });
    console.log('✅ Global commands registered (hard sync).');
  } catch (e) {
    console.error('❌ Failed to register slash commands:', e?.message || e);
  }
}

// ───────────────────── Boot ─────────────────────
async function main() {
  await sodium.ready;

  await registerSlashCommands();

  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // Resolve announce channel (optional)
  if (ANNOUNCE_CHANNEL_ID) {
    try {
      const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
      if (ch && typeof ch.isTextBased === 'function' && ch.isTextBased()) {
        announceChannel = ch;
        console.log(`[ANNOUNCE] Using channel ${ANNOUNCE_CHANNEL_ID} for Now Playing embeds.`);
      } else {
        console.warn('⚠️  ANNOUNCE_CHANNEL_ID is not a text-capable channel. Announcements disabled.');
      }
    } catch {
      console.warn('⚠️  Could not fetch ANNOUNCE_CHANNEL_ID. Announcements disabled.');
    }
  }

  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);

  await ensureConnection();
  console.log('[VC] Waiting for listeners…');
}

process.on('SIGTERM', () => {
  try { stopKeepAlive(); } catch {}
  try { ffmpegProc?.kill('SIGKILL'); } catch {}
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('💀 Fatal boot error:', err?.message || err);
  process.exit(1);
});
