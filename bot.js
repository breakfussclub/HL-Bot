import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
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
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !RSS_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL');
  process.exit(1);
}

// ─────────────────────── Config / Tunables ─────────────────
const REFRESH_RSS_MS = 60 * 60 * 1000; // refresh feed hourly
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;

const OPUS_BITRATE = '96k';
const OPUS_CHANNELS = '2';
const OPUS_APP = 'audio';

const FETCH_UA = 'Mozilla/5.0 (PodcastPlayer/1.0; +https://discord.com)';
const FETCH_ACCEPT = 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8';

const STARTUP_WATCHDOG_MS = 45000; // RELIABLE_MODE

// ───────────────── Discord client / player ────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});

// ───────────────────── Presence helpers ────────────────────
function cleanTitleForStatus(title) {
  if (!title) return 'Podcast';
  let t = String(title)
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\b\w/g, (c) => c.toUpperCase());
  return t || 'Podcast';
}
function setListeningStatus(title) {
  try { client.user?.setActivity(cleanTitleForStatus(title), { type: 2 }); } catch {}
}

// ───────────────────── RSS fetching / order ───────────────
const parser = new Parser({ headers: { 'User-Agent': 'discord-podcast-radio/1.0' } });
let episodes = [];
let episodeIndex = 0;

async function fetchEpisodes() {
  try {
    const feed = await parser.parseURL(RSS_URL);
    const items = (feed.items || [])
      .map((it) => {
        const url = it?.enclosure?.url || it?.link || it?.guid;
        return {
          title: it?.title || 'Untitled',
          url,
          pubDate: it?.pubDate ? new Date(it.pubDate).getTime() : 0,
        };
      })
      .filter((x) => typeof x.url === 'string' && x.url.startsWith('http'));
    items.sort((a, b) => a.pubDate - b.pubDate);
    if (items.length) {
      episodes = items;
      console.log(`RSS Loaded: ${episodes.length} episodes`);
    }
  } catch (err) {
    console.error('RSS fetch failed:', err?.message || err);
  }
}

// ─────────────── axios stream → FFmpeg (stdin) ─────────────
function inferInputFormat(contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('mpeg')) return 'mp3';
  if (ct.includes('x-m4a') || ct.includes('mp4') || ct.includes('aac')) return 'mp4';
  return null;
}

async function axiosStream(url, headers = {}) {
  return axios.get(url, {
    responseType: 'stream',
    maxRedirects: 5,
    headers: {
      'User-Agent': FETCH_UA,
      'Accept': FETCH_ACCEPT,
      'Range': 'bytes=0-',
      ...headers,
    },
    timeout: 60000,
  });
}

function spawnFfmpegFromStream(stream, fmt, offsetMs = 0) {
  const preSeekSec = Math.max(0, Math.floor(offsetMs / 1000)).toString();

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-protocol_whitelist', 'file,http,https,tcp,tls,pipe',
    '-ss', preSeekSec,
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

  stream.on('error', (e) => console.error('HTTP stream error:', e?.message || e));
  stream.pipe(child.stdin);
  child.stderr.on('data', (d) => console.log('[ffmpeg]', d.toString().trim()));
  child.stdin.on('error', () => {});

  return child;
}

// ─────────────── Playback state ────────────────
let hasStartedPlayback = false;
let isPausedDueToEmpty = false;
let resumeOffsetMs = 0;
let startedAtMs = 0;
let ffmpegProc = null;
let currentEpisode = null;
let playLock = false;

function msToHMS(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:` : '') + `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// ───────────────────── Play Loop ─────────────────────
async function playCurrent() {
  if (playLock) return;
  playLock = true;

  try {
    if (!episodes.length) {
      console.log('No episodes yet; retry in 30s…');
      setTimeout(loopPlay, 30_000);
      return;
    }

    currentEpisode = episodes[episodeIndex % episodes.length];
    console.log(`▶️  Now Playing: ${currentEpisode.title}${resumeOffsetMs ? ` (from ${msToHMS(resumeOffsetMs)})` : ''}`);
    setListeningStatus(currentEpisode.title);

    const res = await axiosStream(currentEpisode.url);
    const inputFmt = inferInputFormat(res.headers?.['content-type']);

    ffmpegProc = spawnFfmpegFromStream(res.data, inputFmt, resumeOffsetMs);

    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData && !isPausedDueToEmpty) {
        console.warn('No audio bytes — skipping episode.');
        try { ffmpegProc?.kill('SIGKILL'); } catch {}
        resumeOffsetMs = 0;
        episodeIndex = (episodeIndex + 1) % episodes.length;
        setTimeout(loopPlay, 1500);
      }
    }, STARTUP_WATCHDOG_MS);

    ffmpegProc.stdout.once('data', () => {
      gotData = true;
      clearTimeout(watchdog);
      startedAtMs = Date.now();
      console.log('Audio stream started.');
    });

    const resource = createAudioResource(ffmpegProc.stdout, { inputType: StreamType.OggOpus });
    player.play(resource);
    isPausedDueToEmpty = false;

  } catch (err) {
    console.error('Playback error:', err?.message || err);
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 2000);
  } finally {
    playLock = false;
  }
}

function loopPlay() {
  if (!hasStartedPlayback || isPausedDueToEmpty) return;
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  if (isPausedDueToEmpty) return;
  resumeOffsetMs = 0;
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', (err) => {
  console.error('AudioPlayer error:', err?.message || err);
  if (!isPausedDueToEmpty) {
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 2000);
  }
});

// ───────────────── Voice Connection ─────────────────
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
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID must be a voice channel.');

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected — retrying…');
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

// ───────────────── Auto pause/resume ─────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter((m) => !m.user.bot);

  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
      resumeOffsetMs += elapsed;
      isPausedDueToEmpty = true;

      try { player.pause(); } catch {}
      try { ffmpegProc?.kill('SIGKILL'); } catch {}
      ffmpegProc = null;

      console.log(`[VC] No listeners — paused at ${msToHMS(resumeOffsetMs)}.`);
    }
    return;
  }

  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log('[VC] First listener joined — starting playback.');
    loopPlay();
    return;
  }

  if (isPausedDueToEmpty) {
    console.log(`[VC] Listener joined — resuming from ${msToHMS(resumeOffsetMs)}.`);
    isPausedDueToEmpty = false;
    playCurrent();
  } else if (player.state.status === AudioPlayerStatus.Paused) {
    try { player.unpause(); } catch {}
    console.log('[VC] Listener joined — unpaused.');
  }
});

// ─────────────────────────── Boot ──────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag}`);

  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);

  await ensureConnection();
  console.log('[VC] Waiting for listeners… (will start on first join)');
}

process.on('SIGTERM', () => {
  try { stopKeepAlive(); } catch {}
  try { ffmpegProc?.kill('SIGKILL'); } catch {}
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
