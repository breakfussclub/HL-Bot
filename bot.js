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
import sodium from 'libsodium-wrappers'; // encryption provider for Discord voice

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

// ─── FFmpeg Pipeline: MP3 → PCM (s16le @ 48kHz stereo) ────────────────────────
function ffmpegPCM(url) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-f', 's16le',             // <-- raw PCM for maximum compatibility
    'pipe:1'
  ];
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); // keep logs clean
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
    const pcm = ffmpegPCM(ep.url);
    const resource = createAudioResource(pcm, {
      inputType: StreamType.Raw,  // raw PCM stream
      inlineVolume: false
    });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    // skip to next and try again
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
  // track finished → advance
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
  await sodium.ready; // ensure encryption provider ready

  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag || 'bot'}`);

  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);

  await ensureConnection();
  loopPlay();
}

// graceful shutdown (Railway sends SIGTERM on redeploy)
process.on('SIGTERM', () => {
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
