// Deterministic frame renderer: loads demo.html, calls window.seek(t) for each
// frame, screenshots it and pipes the PNGs into ffmpeg (H.264, yuv420p).
//   node scripts/render.cjs out.mp4 [fps]       → the whole video
//   node scripts/render.cjs --stills 24 34 46   → stills/t<sec>.png
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = path.join(__dirname, '..');
const REPO = path.join(HERE, '..', '..', '..');
const pnpmDir = path.join(REPO, 'node_modules', '.pnpm');
const pw = fs.readdirSync(pnpmDir).find((d) => /^playwright@/.test(d));
const { chromium } = require(path.join(pnpmDir, pw, 'node_modules', 'playwright'));

function headlessShell() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = fs.readdirSync(root).find((d) => d.startsWith('chromium_headless_shell-'));
  return dir ? path.join(root, dir, 'chrome-linux', 'headless_shell') : undefined;
}

(async () => {
  const browser = await chromium.launch({ executablePath: headlessShell() });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('file://' + path.join(HERE, 'demo.html'));
  await page.evaluate(() => document.fonts.ready);

  if (process.argv[2] === '--stills') {
    fs.mkdirSync(path.join(HERE, 'stills'), { recursive: true });
    for (const t of process.argv.slice(3)) {
      await page.evaluate((s) => window.seek(s), Number(t));
      await page.screenshot({ path: path.join(HERE, 'stills', `t${t}.png`) });
    }
    await browser.close();
    return;
  }

  const out = process.argv[2] || path.join(HERE, 'listen-fire-hero.mp4');
  const fps = Number(process.argv[3] || 30);
  const duration = await page.evaluate(() => window.DURATION);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((s) => window.seek(s), i / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (fps * 10) === 0) process.stderr.write(`frame ${i}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await browser.close();
  console.log(out);
})();
