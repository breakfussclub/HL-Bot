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

// ─── Env ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !RSS_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL');
  process.exit(1);
}

// ─── Config (bandwidth + stability) ───────────────────────────────────────────
const REFRESH_RSS_MS = 60 * 60 * 1000;     // refresh feed hourly
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;

// FFmpeg opus: clean stereo, still efficient
const OPUS_BITRATE = '96k';
const OPUS_CHANNELS = '2';
const OPUS_APP = 'audio';                  // better for music + voice

// Headers for remote servers (ffmpeg will use these via -headers)
const FETCH_UA = 'Mozilla/5.0 (PodcastPlayer/1.0; +https://discord.com)';
const FETCH_ACCEPT = 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8';

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
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    // Ascending time: oldest → newest
    items.sort((a, b) => a.pubDate - b.pubDate);
    if (items.length) {
      episodes = items;
      console.log(`RSS Loaded: ${episodes.length} episodes`);
    }
  } catch (err) {
    console.error('RSS fetch failed:', err?.message || err);
  }
}

// ─── FFmpeg: URL → OGG/Opus (with timestamp seek) ────────────────────────────
// We let FFmpeg fetch the URL directly so -ss seeking works reliably.
function spawnFfmpegFromUrl(url, offsetMs = 0) {
  const seekSec = Math.max(0, Math.floor(offsetMs / 1000)).toString();

  // Multi-line headers (CRLF) for ffmpeg HTTP
  const headerBlob = `User-Agent: ${FETCH_UA}\r\nAccept: ${FETCH_ACCEPT}\r\n`;

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Accurate seek for MP3 over HTTP: place -ss AFTER -i; slower but correct.
    '-headers', headerBlob,
    '-i', url,
    '-ss', seekSec,
    '-vn',
    '-ac', OPUS_CHANNELS,
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,
    '-application', OPUS_APP,
    '-f', 'ogg',
    'pipe:1'
  ];

  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });

  return child;
}

// ─── Playback State ───────────────────────────────────────────────────────────
let hasStartedPlayback = false;     // starts only when first listener joins
let isPausedDueToEmpty = false;     // we paused because VC is empty
let resumeOffsetMs = 0;             // accumulated position within current episode
let startedAtMs = 0;                // monotonic start time for current run
let ffmpegProc = null;              // current ffmpeg process (kill on pause)
let currentEpisode = null;          // {title, url, pubDate}

// ─── Playback Loop (timestamp-resumable) ─────────────────────────────────────
function msToHMS(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:` : '') + `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

async function playCurrent() {
  if (!episodes.length) {
    console.log('No episodes yet; retry in 30s…');
    setTimeout(loopPlay, 30_000);
    return;
  }

  currentEpisode = episodes[episodeIndex % episodes.length];
  console.log(`▶️  Now Playing: ${currentEpisode.title}${resumeOffsetMs ? ` (from ${msToHMS(resumeOffsetMs)})` : ''}`);
  setListeningStatus(currentEpisode.title);

  try {
    // Spawn ffmpeg directly from URL with -ss seek
    ffmpegProc = spawnFfmpegFromUrl(currentEpisode.url, resumeOffsetMs);

    // Simple watchdog in case remote stalls
    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData && !isPausedDueToEmpty) {
        console.warn('No audio bytes after 8s — skipping episode.');
        try { ffmpegProc?.kill('SIGKILL'); } catch {}
        ffmpegProc = null;
        // Advance to next episode
        resumeOffsetMs = 0;
        episodeIndex = (episodeIndex + 1) % episodes.length;
        setTimeout(loopPlay, 1500);
      }
    }, 8000);

    ffmpegProc.stdout.once('data', () => {
      gotData = true;
      clearTimeout(watchdog);
      startedAtMs = Date.now();
      console.log('Audio stream started.');
    });

    const resource = createAudioResource(ffmpegProc.stdout, {
      inputType: StreamType.OggOpus
    });

    player.play(resource);
    isPausedDueToEmpty = false;
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    // advance to next episode on failure
    resumeOffsetMs = 0;
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  if (!hasStartedPlayback || isPausedDueToEmpty) return;
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5000);
  });
}

// When track naturally ends, move to next episode and reset offset
player.on(AudioPlayerStatus.Idle, () => {
  if (isPausedDueToEmpty) return; // paused—do nothing
  resumeOffsetMs = 0;
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  if (isPausedDueToEmpty) return;
  // On error, advance but keep running
  resumeOffsetMs = 0;
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 2000);
});

// ─── Voice Connection + Keep-Alive (prevents AFK disconnect) ──────────────────
let connection = null;
let keepAliveInterval = null;

function startKeepAlive(conn) {
  stopKeepAlive();
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

// ─── Auto Pause/Resume + Wait-for-First-Listener (with timestamp resume) ─────
client.on('voiceStateUpdate', (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter(m => !m.user.bot);

  // Empty: pause stream & record timestamp
  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      // accumulate elapsed into resumeOffsetMs
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

  // Someone joined:
  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log('[VC] First listener joined — starting playback.');
    // begin loop
    loopPlay();
    return;
  }

  // If we paused due to empty, resume by spawning ffmpeg at the saved offset
  if (isPausedDueToEmpty) {
    console.log(`[VC] Listener joined — resuming from ${msToHMS(resumeOffsetMs)}.`);
    isPausedDueToEmpty = false;
    playCurrent();
  } else if (player.state.status === AudioPlayerStatus.Paused) {
    try { player.unpause(); } catch {}
    console.log('[VC] Listener joined — unpaused.');
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
  // We intentionally do NOT call loopPlay() here; we wait for the first listener.
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
