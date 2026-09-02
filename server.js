const express = require('express');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

const MAX_FRAMES = 12;

const LAUNCH_OPTS = {
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
};

app.post('/render/tgs', async (req, res) => {
  let browser;
  try {
    const tgsBytes = req.body;
    const lottieJson = zlib.gunzipSync(tgsBytes).toString('utf8');
    const lottieData = JSON.parse(lottieJson);

    browser = await puppeteer.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.setViewport({ width: 512, height: 512 });

    const html = `
      <html><body style="margin:0;background:transparent;">
      <div id="anim" style="width:512px;height:512px;"></div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.13.0/lottie.min.js"></script>
      <script>
        window.anim = lottie.loadAnimation({
          container: document.getElementById('anim'),
          renderer: 'canvas',
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
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
      const base64 = await page.evaluate(() => {
        const canvas = document.querySelector('#anim canvas');
        return canvas ? canvas.toDataURL('image/png').split(',')[1] : null;
      });
      if (base64) frames.push(base64);
    }

    await browser.close();

    // Safety check: if rendering failed to actually vary frame-to-frame,
    // don't ship a fake "animation" — collapse to a single accurate costume.
    let finalFrames = frames;
    if (frames.length > 1) {
      const first = frames[0];
      const last = frames[frames.length - 1];
      const middle = frames[Math.floor(frames.length / 2)];
      if (first === last && last === middle) {
        finalFrames = [frames[frames.length - 1]]; // use the last frame as the single costume
      }
    }

    res.json({ frames: finalFrames, width: 512, height: 512 });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
});

app.post('/debug/tgs-frames', async (req, res) => {
  let browser;
  try {
    const tgsBytes = req.body;
    const lottieJson = zlib.gunzipSync(tgsBytes).toString('utf8');
    const lottieData = JSON.parse(lottieJson);

    browser = await puppeteer.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.setViewport({ width: 512, height: 512 });

    const html = `
      <html><body style="margin:0;background:transparent;">
      <div id="anim" style="width:512px;height:512px;"></div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.13.0/lottie.min.js"></script>
      <script>
        window.anim = lottie.loadAnimation({
          container: document.getElementById('anim'),
          renderer: 'canvas',
          loop: false,
          autoplay: false,
          animationData: ${lottieJson}
        });
      </script>
      </body></html>
    `;
    await page.setContent(html);
    await page.waitForFunction(() => window.anim && window.anim.isLoaded);

    async function getPixelSum(frame) {
      await page.evaluate((f) => window.anim.goToAndStop(f, true), frame);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
      return await page.evaluate(() => {
        const canvas = document.querySelector('#anim canvas');
        const ctx = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        for (let i = 0; i < imgData.data.length; i++) sum += imgData.data[i];
        return sum;
      });
    }

    const sumStart = await getPixelSum(lottieData.ip);
    const sumMid = await getPixelSum(Math.floor((lottieData.ip + lottieData.op) / 2));
    const sumEnd = await getPixelSum(lottieData.op);

    await browser.close();
    res.json({
      pixelSums: { start: sumStart, mid: sumMid, end: sumEnd },
      framesIdentical: (sumStart === sumMid && sumMid === sumEnd)
    });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
});

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
