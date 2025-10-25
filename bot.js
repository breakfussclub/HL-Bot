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

// ─── FFmpeg: stdin MP3 → stdout OGG/Opus (Discord-compatible) ─────────────────
function ffmpegOggOpus(readable) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'mp3',
    '-i', 'pipe:0',
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', '128k',
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

// ─── Voice Connection ─────────────────────────────────────────────────────────
let connection = null;
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
          ensureConnection();
        }, REJOIN_DELAY_MS);
      }
    });

    connection.subscribe(player);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag}`);

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
