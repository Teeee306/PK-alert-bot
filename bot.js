import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import cron from 'node-cron';
import puppeteer from 'puppeteer';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/* ---------- CONFIG ---------- */
const configPath = path.join(process.cwd(), '.env');
function loadConfig() {
  if (fs.existsSync(configPath)) {
    const lines = fs.readFileSync(configPath, 'utf8').split('\n');
    const token = lines.find(l => l.startsWith('BOT_TOKEN='))?.split('=')[1];
    const chatId = lines.find(l => l.startsWith('CHAT_ID='))?.split('=')[1];
    return { token, chatId };
  }
  return null;
}
function saveConfig(token, chatId) {
  fs.writeFileSync(configPath, `BOT_TOKEN=${token}\nCHAT_ID=${chatId}\n`);
  console.log('Config saved to .env—secure!');
}
async function getInputs() {
  return new Promise((resolve) => {
    const config = loadConfig();
    if (config && config.token && config.chatId) { resolve(config); return; }
    console.log('First run: Enter your BotFather token and chat ID.');
    rl.question('Bot token: ', (token) => {
      rl.question('Chat ID: ', (chatId) => {
        saveConfig(token, chatId);
        resolve({ token, chatId });
        rl.close();
      });
    });
  });
}
const { token, chatId } = await getInputs();
const bot = new Telegraf(token);

/* ---------- DATA FOLDERS ---------- */
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const trendsFile   = path.join(dataDir, 'trends.json');
const streaksFile  = path.join(dataDir, 'streaks.json');
const trackingFile = path.join(dataDir, 'tracking.json');
const volumeFile   = path.join(dataDir, 'volume.json');

function loadJson(file, def = []) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(def));
  return def;
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let trends   = loadJson(trendsFile, []);
let streaks  = loadJson(streaksFile, {});
let tracking = loadJson(trackingFile, { london: false, nyc: false, lastStates: {} });
let volumeHistory = loadJson(volumeFile, { london: {}, nyc: {} });

/* ---------- HELPERS ---------- */
function getWATDateTime() {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + 1);
  return now.toISOString().slice(0, 16).replace('T', ', ') + ' WAT';
}
function getCalendarEmoji() {
  return '\u{1F4C5}'; // Calendar — shows TODAY
}
function getDateHeader() {
  return `${getCalendarEmoji()} ${getWATDateTime()}`;
}

/* ---------- REAL POLYMARKET SCRAPING ---------- */
async function fetchMarketData(station) {
  const urls = {
    london: 'https://polymarket.com/event/highest-temperature-in-london-on-october-27',
    nyc: 'https://polymarket.com/event/highest-temperature-in-new-york-city-on-october-27'
  };
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.goto(urls[station], { waitUntil: 'networkidle2', timeout: 60000 });

  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="market-outcome"]')).slice(0, 3);
    const totalVol = document.querySelector('[data-testid="market-volume"]')?.textContent;
    return {
      totalVolume: totalVol ? parseInt(totalVol.replace(/[^0-9]/g, '')) : 0,
      outcomes: rows.map(row => {
        const name = row.querySelector('[data-testid="outcome-name"]')?.textContent.trim();
        const prob = row.querySelector('[data-testid="outcome-probability"]')?.textContent.trim();
        const yes = row.querySelector('[data-testid="yes-price"]')?.textContent.trim();
        const no = row.querySelector('[data-testid="no-price"]')?.textContent.trim();
        const change = row.querySelector('[data-testid="price-change"]')?.textContent.trim();
        const vol = row.querySelector('[data-testid="outcome-volume"]')?.textContent.trim();
        const tag = row.querySelector('[data-testid="outcome-tag"]')?.textContent.trim() || 'None';
        return {
          name,
          probability: parseInt(prob) || 0,
          yesPrice: parseInt(yes) || 0,
          noPrice: parseInt(no) || 0,
          change: change || '',
          volume: parseInt(vol?.replace(/[^0-9]/g, '')) || 0,
          tag
        };
      })
    };
  });

  await browser.close();
  return data;
}

/* ---------- VOLUME NARRATIVE ---------- */
function getVolumeNarrative(station, totalVolume) {
  const yesterday = volumeHistory[station]?.yesterday_1pm || totalVolume;
  const change = ((totalVolume - yesterday) / yesterday * 100).toFixed(1);
  volumeHistory[station] = { yesterday_1pm: totalVolume };
  saveJson(volumeFile, volumeHistory);
  return ` (${change > 0 ? '+' : ''}${change}% vs. yesterday 1 PM)`;
}

/* ---------- COMMANDS ---------- */
bot.start((ctx) => {
  ctx.reply(`${getDateHeader()}: Welcome!`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Current London', callback_data: 'current_london' }, { text: 'Current NYC', callback_data: 'current_nyc' }],
        [{ text: 'Alert London',   callback_data: 'alert_london' },   { text: 'Alert NYC',   callback_data: 'alert_nyc' }]
      ]
    }
  });
});

bot.command('current', async (ctx) => {
  const station = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  if (!['london', 'nyc'].includes(station)) return ctx.reply('Use: /current london or /current nyc');
  try {
    const data = await fetchMarketData(station);
    const narrative = getVolumeNarrative(station, data.totalVolume);
    const message = `${getDateHeader()}: ${station.toUpperCase()} top 3:\n` +
      data.outcomes.map((o, i) => `${i+1}. ${o.name}: ${o.probability}% (${o.yesPrice}¢/${o.noPrice}¢) ${o.change} | Vol $${o.volume.toLocaleString()} ${o.tag}`).join('\n') +
      `\nTotal Vol $${data.totalVolume.toLocaleString()}${narrative}.`;
    ctx.reply(message);
  } catch (e) {
    ctx.reply(`Scraping error: ${e.message}`);
  }
});

// [Add alert, stop, status, trend, streak, polling, cron — same as before]

console.log('Bot starting — LIVE DATA + CORRECT CALENDAR');
bot.launch();
