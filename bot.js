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
  demuxProbe
} from '@discordjs/voice';
import Parser from 'rss-parser';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const {
  DISCORD_TOKEN,
  VOICE_CHANNEL_ID,
  GUILD_ID,
  RSS_URL
} = process.env;

if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !RSS_URL) {
  console.error('Missing env. You must set DISCORD_TOKEN, VOICE_CHANNEL_ID, RSS_URL');
  process.exit(1);
}

const REFRESH_RSS_MS = 60 * 60 * 1000; // check hourly
const REJOIN_DELAY_MS = 5000;
const START_AT_OLDEST = true;
const SELF_DEAFEN = true;
const FF_PATH = ffmpeg;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const parser = new Parser({
  headers: { 'User-Agent': 'discord-podcast-radio/1.0' }
});

let episodes = [];
let episodeIndex = 0;
let connection = null;
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

async function fetchEpisodes() {
  const feed = await parser.parseURL(RSS_URL);
  const items = (feed.items || [])
    .map(it => {
      const url = it?.enclosure?.url || it?.link || it?.guid;
      return {
        title: it.title || 'Untitled',
        url,
        pubDate: it.pubDate ? new Date(it.pubDate).getTime() : 0
      };
    })
    .filter(x => typeof x.url === 'string' && x.url.startsWith('http'));

  items.sort((a, b) => a.pubDate - b.pubDate);
  if (items.length) episodes = items;

  console.log(`RSS Loaded: ${episodes.length} episodes`);
}

function ffmpegStream(url) {
  const args = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-f', 'opus',
    'pipe:1'
  ];
  const child = spawn(FF_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  return child.stdout;
}

async function resourceFromUrl(url) {
  const stream = ffmpegStream(url);
  const { stream: probed, type } = await demuxProbe(stream);
  return createAudioResource(probed, { inputType: type });
}

async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) {
    throw new Error('VOICE_CHANNEL_ID must be a voice channel.');
  }

  if (connection) return connection;

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: SELF_DEAFEN
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.warn('Voice disconnected — trying to recover...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      setTimeout(() => {
        connection.destroy();
        connection = null;
        ensureConnection().catch(console.error);
      }, REJOIN_DELAY_MS);
    }
  });

  connection.subscribe(player);
  return connection;
}

async function playCurrent() {
  if (!episodes.length) {
    setTimeout(loopPlay, 30000);
    return;
  }

  const ep = episodes[episodeIndex % episodes.length];
  console.log(`▶️  Now Playing: ${ep.title}`);

  try {
    const resource = await resourceFromUrl(ep.url);
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err.message);
    episodeIndex = (episodeIndex + 1) % episodes.length;
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playCurrent().catch(err => {
    console.error('Loop error:', err.message);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  episodeIndex = (episodeIndex + 1) % episodes.length;
  setTimeout(loopPlay, 1500);
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await fetchEpisodes();
  setInterval(fetchEpisodes, REFRESH_RSS_MS);
  await ensureConnection();
  loopPlay();
});

client.login(DISCORD_TOKEN);
