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
const REFRESH_RSS_MS = 60 * 60 * 1000; // refresh feed hourly
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;
const FETCH_HEADERS = {
  // Some podcast CDNs care about UA/accept
  'User-Agent': 'Mozilla/5.0 (PodcastPlayer/1.0; +https://discord.com)',
  'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
};

// ─── Discord Client / Voice Player ────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

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

    items.sort((a, b) => a.pubDate - b.pubDate); // oldest → newest
    if (items.length) {
      episodes = items;
      console.log(`RSS Loaded: ${episodes.length} episodes`);
    } else {
      console.warn('RSS loaded but found 0 playable items; keeping previous list.');
    }
  } catch (err) {
    console.error('RSS fetch failed:', err?.message || err);
  }
}

// ─── HTTP fetch → Node Readable (handles redirects + headers) ─────────────────
async function getAudioReadable(url) {
  // Node 18+ has global fetch. We follow redirects and pass friendly headers.
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: FETCH_HEADERS
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} from audio URL`);
  }

  // Convert WHATWG ReadableStream to Node Readable
  const nodeReadable = Readable.fromWeb(res.body);
  return { stream: nodeReadable, finalUrl: res.url };
}

// ─── FFmpeg: Read from stdin (podcast bytes) → WebM/Opus to stdout ───────────
function ffmpegFromReadable(readable) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Important when input comes from stdin:
    '-f', 'mp3',           // Anchor/Spotify enclosures are MP3; hint format for stability
    '-i', 'pipe:0',        // read audio from stdin
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-application', 'audio',
    '-frame_duration', '60',
    '-f', 'webm',
    'pipe:1'
  ];

  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  // Pipe fetched audio into ffmpeg stdin
  readable.on('error', (e) => {
    console.error('Input stream error:', e?.message || e);
    try { child.stdin.end(); } catch {}
  });
  readable.pipe(child.stdin);

  // Debug: surface ffmpeg warnings/errors
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });

  return child.stdout;
}

// ─── Playback Loop ────────────────────────────────────────────────────────────
async function playCurrent() {
  if (!episodes.length) {
    console.log('No episodes yet; retrying in 30s…');
    setTimeout(loopPlay, 30_000);
    return;
  }

  const ep = episodes[episodeIndex % episodes.length];
  console.log(`▶️  Now Playing: ${ep.title}`);

  try {
    // 1) Fetch audio ourselves (follow redirects, set headers)
    const { stream: inputReadable, finalUrl } = await getAudioReadable(ep.url);
    console.log(`Fetching audio from: ${finalUrl}`);

    // 2) Pipe into ffmpeg; 3) Pipe webm/opus into Discord
    const webmOut = ffmpegFromReadable(inputReadable);

    // Watchdog: if no bytes leave ffmpeg in 8s, skip to next track
    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData) {
        console.warn('No audio bytes from ffmpeg after 8s — skipping track.');
        try { webmOut.destroy(); } catch {}
        episodeIndex = (episodeIndex + 1) % Math.max(1, episodes.length);
        setTimeout(loopPlay, 1_500);
      }
    }, 8000);

    webmOut.once('data', () => {
      gotData = true;
      clearTimeout(watchdog);
      console.log('Audio stream started.');
    });

    const resource = createAudioResource(webmOut, {
      inputType: StreamType.WebmOpus,
      inlineVolume: false
    });

    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    episodeIndex = (episodeIndex + 1) % Math.max(1, episodes.length);
    setTimeout(loopPlay, 2_000);
  }
}

function loopPlay() {
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5_000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  episodeIndex = (episodeIndex + 1) % Math.max(1, episodes.length);
  setTimeout(loopPlay, 1_500);
});

player.on('error', (err) => {
  console.error('AudioPlayer error:', err?.message || err);
  episodeIndex = (episodeIndex + 1) % Math.max(1, episodes.length);
  setTimeout(loopPlay, 2_000);
});

// ─── Voice Connection ─────────────────────────────────────────────────────────
let connection = null;

async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID is not a voice channel I can access.');

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected — attempting recovery…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        console.log('Reconnected without rejoin.');
      } catch {
        setTimeout(() => {
          try { connection?.destroy(); } catch {}
          connection = null;
          ensureConnection().catch(err => console.error('Rejoin failed:', err?.message || err));
        }, REJOIN_DELAY_MS);
      }
    });

    connection.subscribe(player);
  }

  return connection;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready; // ensure encryption provider is ready first

  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag || 'bot'}`);

  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);

  await ensureConnection();
  loopPlay();
}

process.on('SIGTERM', () => {
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
