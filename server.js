const html = `
  <html><body style="margin:0;background:transparent;">
  <canvas id="anim" width="512" height="512"></canvas>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
  <script>
    window.anim = lottie.loadAnimation({
      container: document.getElementById('anim'),
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: ${lottieJson},
      rendererSettings: { clearCanvas: true, context: document.getElementById('anim').getContext('2d') }
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
  const base64 = await page.evaluate(() => document.getElementById('anim').toDataURL('image/png').split(',')[1]);
  frames.push(base64);
}
