import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType
} from '@discordjs/voice';
import Parser from 'rss-parser';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import sodium from 'libsodium-wrappers';
import { Readable } from 'node:stream';

// ─── Env ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !RSS_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
// Bandwidth savers: lower opus bitrate + mono; wait-to-start; pause-when-empty
const OPUS_BITRATE = process.env.OPUS_BITRATE || '64k'; // podcast-friendly
const OPUS_CHANNELS = process.env.OPUS_CHANNELS || '1'; // mono saves ~50%
const REFRESH_RSS_MS = 60 * 60 * 1000; // refresh feed hourly
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (PodcastPlayer/1.0; +https://discord.com)',
  'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
};

// ─── Discord Client / Voice Player ────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// Keep connection alive even without subscribers
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

// ─── Presence helpers ─────────────────────────────────────────────────────────
function cleanTitleForStatus(title) {
  if (!title) return 'Podcast';
  let t = String(title)
    .replace(/\.[^/.]+$/, '')      // drop extension if any
    .replace(/[-_]+/g, ' ')        // nicer spacing
    .replace(/\s+/g, ' ')          // collapse spaces
    .trim();
  // Capitalize words
  t = t.replace(/\b\w/g, c => c.toUpperCase());
  return t || 'Podcast';
}

function setListeningStatus(title) {
  try {
    client.user?.setActivity(cleanTitleForStatus(title), { type: 2 }); // LISTENING
  } catch {}
}

// ─── RSS Handling ─────────────────────────────────────────────────────────────
const parser = new Parser({ headers: { 'User-Agent': 'discord-podcast-radio/1.0' } });
let episodes = [];
let episodeIndex = 0;

async function fetchEpisodes() {
  try {
    const feed = await parser.parseURL(RSS_URL);
    const items = (feed.items || [])
      .map(it => {
        const url = it?.enclosure?.url || it?.link || it?.guid;
        return {
          title: it?.title || 'Untitled',
          url,
          pubDate: it?.pubDate ? new Date(it.pubDate).getTime() : 0
        };
      })
      .filter(x => typeof x.url === 'string' && x.url.startsWith('http'));

    // Ascending by time so we loop oldest→newest
    items.sort((a, b) => a.pubDate - b.pubDate);
    if (items.length) {
      episodes = items;
      console.log(`RSS Loaded: ${episodes.length} episodes`);
    }
  } catch (err) {
    console.error('RSS fetch failed:', err?.message || err);
  }
}

// ─── HTTP fetch → Node Readable ───────────────────────────────────────────────
async function getAudioReadable(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: FETCH_HEADERS
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} from audio URL`);
  }

  return Readable.fromWeb(res.body);
}

// ─── FFmpeg: stdin MP3/AAC/etc → stdout OGG/Opus (low bandwidth) ─────────────
function ffmpegOggOpus(readable) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'mp3',                // many podcast feeds are mp3; ffmpeg will auto-detect if not exact
    '-i', 'pipe:0',
    '-vn',
    '-ac', OPUS_CHANNELS,       // 1 = mono
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,       // 64k default (good for voice)
    '-application', 'voip',     // opus tuning optimized for speech
    '-frame_duration', '60',    // fewer packets per second → tiny overhead savings
    '-f', 'ogg',
    'pipe:1'
  ];

  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  readable.on('error', e => console.error('Input stream error:', e?.message || e));
  readable.pipe(child.stdin);

  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });

  return child.stdout;
}

// ─── Playback Loop (will begin only when we have a listener) ──────────────────
let hasStartedPlayback = false;

async function playCurrent() {
  if (!episodes.length) {
    console.log('No episodes yet; retrying in 30s…');
    setTimeout(loopPlay, 30_000);
    return;
  }

  const ep = episodes[episodeIndex % episodes.length];
  console.log(`▶️  Now Playing: ${ep.title}`);
  setListeningStatus(ep.title);

  try {
    const inputReadable = await getAudioReadable(ep.url);
    const oggOut = ffmpegOggOpus(inputReadable);

    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData) {
        console.warn('No audio bytes after 8s — skipping track.');
        try { oggOut.destroy(); } catch {}
        episodeIndex = (episodeIndex + 1) % episodes.length;
        setTimeout(loopPlay, 1_500);
      }
    }, 8000);

    oggOut.once('data', () => {
      gotData = true;
      clearTimeout(watchdog);
      console.log('Audio stream started.');
    });

    const resource = createAudioResource(oggOut, {
      inputType: StreamType.OggOpus
    });

    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 2_000);
  }
}

function loopPlay() {
  // Only proceed if we have started playback (i.e., at least one listener joined)
  if (!hasStartedPlayback) return;
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5_000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 1_500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 2_000);
});

// ─── Voice Connection + Keep-Alive (prevents AFK disconnect) ──────────────────
let connection = null;
let keepAliveInterval = null;

function startKeepAlive(conn) {
  stopKeepAlive();
  // Light-weight keep-alive to keep the networking stack refreshed while paused/idle
  keepAliveInterval = setInterval(() => {
    try { conn?.configureNetworking(); } catch {}
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID must be a voice channel.');

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected — retrying…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
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

// ─── Auto Pause/Resume + Wait-for-First-Listener ─────────────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter(m => !m.user.bot);

  // Empty: pause ONLY if currently playing
  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      player.pause();
      console.log('[VC] No listeners — pausing playback.');
    }
    return;
  }

  // Someone joined:
  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log('[VC] First listener joined — starting playback.');
    // Kick off the loop from here
    loopPlay();
    return;
  }

  if (player.state.status === AudioPlayerStatus.Paused) {
    player.unpause();
    console.log('[VC] Listener joined — resuming playback.');
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag}`);

  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);

  await ensureConnection();
  console.log('[VC] Waiting for listeners… (will start on first join)');
  // Do NOT call loopPlay() here; we wait for the first listener.
}

process.on('SIGTERM', () => {
  try { stopKeepAlive(); } catch {}
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
