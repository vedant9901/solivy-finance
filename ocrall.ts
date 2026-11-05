import fs from 'node:fs';
import { readPdf } from './lib/grn/pdf-native';
import { recognisePage } from './lib/grn/ocr-wasm';
(async () => {
  const buf = fs.readFileSync('/tmp/claude-0/smc/smc.pdf');
  const doc = readPdf(buf, { withImages: true, maxPages: 20 });
  for (const p of doc.pages) {
    const img = [...p.images].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    const dpi = Math.round(img.width / (p.width/72));
    const r = await recognisePage(img.bytes, { dpi, imageSize: { width: img.width, height: img.height } });
    fs.writeFileSync(`/tmp/claude-0/smc/p${String(p.page).padStart(2,'0')}.txt`, r.text);
    fs.writeFileSync(`/tmp/claude-0/smc/p${String(p.page).padStart(2,'0')}.words.json`, JSON.stringify({width:r.width,height:r.height,words:r.words}));
    console.log(`p${p.page}: ${r.ms}ms conf=${r.confidence} chars=${r.text.replace(/\s/g,'').length}`);
  }
})();
