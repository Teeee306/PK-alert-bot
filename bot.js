import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { chromium } from 'playwright';

// === SECRETS FROM REPLIT ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
if (!BOT_TOKEN || !CHAT_ID) {
  console.log('Add BOT_TOKEN and CHAT_ID in Replit Secrets');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// === DATA FOLDER ===
const dataDir = 'data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const files = {
  trends: path.join(dataDir, 'trends.json'),
  tracking: path.join(dataDir, 'tracking.json'),
  volume: path.join(dataDir, 'volume.json')
};
function load(file, def) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(def));
  return def;
}
function save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

let trends = load(files.trends, []);
let tracking = load(files.tracking, { london: false, nyc: false, last: {} });
let volume = load(files.volume, { london: {}, nyc: {} });

// === HELPERS ===
function now() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16).replace('T', ', ') + ' WAT';
}
function header() { return `📅 ${now()}`; }

// === SCRAPE POLYMARKET ===
async function scrape(station) {
  const urls = {
    london: 'https://polymarket.com/event/highest-temperature-in-london-on-october-27',
    nyc: 'https://polymarket.com/event/highest-temperature-in-new-york-city-on-october-27'
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(urls[station], { waitUntil: 'networkidle' });
  await page.waitForTimeout(8000);

  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="market-outcome"]')).slice(0, 3);
    const total = document.querySelector('[data-testid="market-volume"]')?.innerText;
    return {
      total: total ? parseInt(total.replace(/[^0-9]/g, '')) : 0,
      outcomes: rows.map(r => ({
        name: r.querySelector('[data-testid="outcome-name"]')?.innerText?.trim(),
        prob: parseInt(r.querySelector('[data-testid="outcome-probability"]')?.innerText) || 0,
        yes: parseInt(r.querySelector('[data-testid="yes-price"]')?.innerText) || 0,
        no: parseInt(r.querySelector('[data-testid="no-price"]')?.innerText) || 0,
        change: r.querySelector('[data-testid="price-change"]')?.innerText?.trim() || '',
        vol: parseInt(r.querySelector('[data-testid="outcome-volume"]')?.innerText?.replace(/[^0-9]/g, '')) || 0,
        tag: r.querySelector('[data-testid="outcome-tag"]')?.innerText?.trim() || 'None'
      }))
    };
  });

  await browser.close();
  return data;
}

// === COMMANDS ===
bot.start(ctx => ctx.reply(`${header()}: Use /current london`));

bot.command('current', async ctx => {
  const station = ctx.message.text.split(' ')[1]?.toLowerCase();
  if (!['london', 'nyc'].includes(station)) return ctx.reply('Use: /current london or /current nyc');

  try {
    const d = await scrape(station);
    const change = ((d.total - (volume[station]?.last || d.total)) / (volume[station]?.last || 1) * 100).toFixed(1);
    volume[station] = { last: d.total };
    save(files.volume, volume);

    const msg = `${header()}: ${station.toUpperCase()} TOP 3\n` +
      d.outcomes.map((o, i) => `${i+1}. ${o.name}: ${o.prob}%\n   ${o.yes}¢/${o.no}¢ ${o.change} | $${o.vol} ${o.tag}`).join('\n') +
      `\n\nTotal: $${d.total.toLocaleString()} (${change > 0 ? '+' : ''}${change}%)`;

    ctx.reply(msg);
  } catch (e) {
    ctx.reply(`Error: ${e.message}`);
  }
});

console.log('Bot starting — LIVE DATA + CORRECT CALENDAR');
bot.launch();
