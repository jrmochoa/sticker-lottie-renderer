const express = require('express');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

const MAX_FRAMES = 12; // still used by webm route for now

// ---------- TGS (Lottie) rendering ----------
app.post('/render/tgs', async (req, res) => {
  let browser;
  try {
    const tgsBytes = req.body;
    const lottieJson = zlib.gunzipSync(tgsBytes).toString('utf8');
    const lottieData = JSON.parse(lottieJson);

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 512, height: 512 });

    const html = `
      <html><body style="margin:0;background:transparent;">
      <div id="anim" style="width:512px;height:512px;"></div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
      <script>
        window.anim = lottie.loadAnimation({
          container: document.getElementById('anim'),
          renderer: 'svg',
          loop: false,
          autoplay: false,
          animationData: ${lottieJson}
        });
      </script>
      </body></html>
    `;
    await page.setContent(html);
    await page.waitForFunction(() => window.anim && window.anim.isLoaded);

    const frames = [];
    for (let f = lottieData.ip; f <= lottieData.op; f += 1) {
      await page.evaluate((frame) => window.anim.goToAndStop(frame, true), f);
      const el = await page.$('#anim');
      const shot = await el.screenshot({ type: 'png', omitBackground: true });
      frames.push(shot.toString('base64'));
    }

    await browser.close();
    res.json({ frames, width: 512, height: 512 });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
});

// ---------- WEBM (video) frame extraction ----------
app.post('/render/webm', async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webm-'));
  const inputPath = path.join(tmpDir, 'input.webm');
  try {
    fs.writeFileSync(inputPath, req.body);

    const probeOut = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 ${inputPath}`
    ).toString().trim();
    const duration = parseFloat(probeOut) || 3;
    const fps = Math.max(1, MAX_FRAMES / duration);

    execSync(
      `ffmpeg -i ${inputPath} -vf fps=${fps} -vframes ${MAX_FRAMES} ${tmpDir}/frame_%03d.png`
    );

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('frame_')).sort();
    const frames = files.map(f => fs.readFileSync(path.join(tmpDir, f)).toString('base64'));

    res.json({ frames, width: 512, height: 512 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.get('/', (req, res) => res.send('Sticker Lottie Renderer is running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
