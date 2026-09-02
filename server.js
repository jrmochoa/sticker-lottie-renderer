const express = require('express');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

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

async function captureFrame(page, frameNum) {
  return await page.evaluate((f) => {
    window.anim.currentFrame = f;
    window.anim.renderer.renderFrame(f);
    const canvas = document.querySelector('#anim canvas');
    return canvas ? canvas.toDataURL('image/png') : null;
  }, frameNum);
}

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
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
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
      const dataUrl = await captureFrame(page, f);
      if (dataUrl) frames.push(dataUrl.split(',')[1]);
    }

    await browser.close();

    let finalFrames = frames;
    if (frames.length > 1) {
      const first = frames[0];
      const last = frames[frames.length - 1];
      const middle = frames[Math.floor(frames.length / 2)];
      if (first === last && last === middle) {
        finalFrames = [frames[frames.length - 1]];
      }
    }

    res.json({ frames: finalFrames, width: 512, height: 512, fr: lottieData.fr });
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

    const fpsOut = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 ${inputPath}`
    ).toString().trim();
    const [num, den] = fpsOut.split('/').map(Number);
    const nativeFps = den ? num / den : 30;

    execSync(
      `ffmpeg -i ${inputPath} -vf fps=${nativeFps} -vsync 0 ${tmpDir}/frame_%04d.png`
    );

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('frame_')).sort();
    const frames = files.map(f => fs.readFileSync(path.join(tmpDir, f)).toString('base64'));

    res.json({ frames, width: 512, height: 512, fps: nativeFps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.get('/', (req, res) => res.send('Sticker Lottie Renderer is running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
