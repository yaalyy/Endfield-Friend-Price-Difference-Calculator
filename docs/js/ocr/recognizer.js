// 图片识别：懒加载 Tesseract.js（在其自带 Worker 中运行），整图 OCR → 坐标配对 → 字段精细识别
// 对外只返回 [{ name, price, discount }]，无法识别的字段为 null
(function (root) {
    'use strict';
    const P = root.OcrParse;
    const Pair = root.OcrPair;

    const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const MAX_SIDE = 2600;
    const MIN_WIDTH = 1600;

    const assetUrl = path => new URL(path, document.baseURI).href;

    class CancelledError extends Error {
        constructor() { super('已取消'); this.name = 'CancelledError'; }
    }

    let libraryPromise = null;
    function loadLibrary() {
        if (root.Tesseract) return Promise.resolve(root.Tesseract);
        if (!libraryPromise) {
            libraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = assetUrl('vendor/tesseract/tesseract.min.js');
                script.onload = () => resolve(root.Tesseract);
                script.onerror = () => { libraryPromise = null; script.remove(); reject(new Error('识别组件加载失败，请检查网络后重试。')); };
                document.head.appendChild(script);
            });
        }
        return libraryPromise;
    }

    // 读取图片并按 EXIF 方向摆正，缩放到适合识别的尺寸
    async function loadImage(file) {
        if (!file || !ACCEPTED_TYPES.includes(file.type)) throw new Error('仅支持 JPEG、PNG、WebP 图片。');
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (error) {
            throw new Error('图片无法读取，请重新上传。');
        }
        let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        if (bitmap.width * scale < MIN_WIDTH) scale = Math.min(MIN_WIDTH / bitmap.width, MAX_SIDE / Math.max(bitmap.width, bitmap.height), 3);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return deskew(canvas);
    }

    // 手机拍屏常有轻微倾斜，会让同一行的名称条连成一条：估计倾斜角并反向旋转。截图角度为 0，不做处理。
    function deskew(canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const deg = Pair.estimateSkew({ data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height });
        if (Math.abs(deg) < 0.3) return canvas;
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const octx = out.getContext('2d', { willReadFrequently: true });
        octx.fillStyle = '#000';
        octx.fillRect(0, 0, out.width, out.height);
        octx.imageSmoothingQuality = 'high';
        octx.translate(out.width / 2, out.height / 2);
        octx.rotate(-deg * Math.PI / 180);
        octx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        out.skewDeg = deg;
        return out;
    }

    function clampRect(rect, canvas) {
        const x0 = Math.max(0, Math.floor(rect.x0)), y0 = Math.max(0, Math.floor(rect.y0));
        const x1 = Math.min(canvas.width, Math.ceil(rect.x1)), y1 = Math.min(canvas.height, Math.ceil(rect.y1));
        return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x0, y0, x1, y1 } : null;
    }

    function pad(bbox, px, py) {
        return { x0: bbox.x0 - px, y0: bbox.y0 - py, x1: bbox.x1 + px, y1: bbox.y1 + py };
    }

    // 裁剪区域：放大、灰度、拉伸对比度；暗底亮字时反色（Tesseract 偏好白底黑字）
    // mode: 'luma'（默认，亮度）| 'max'（RGB 最大值，适合彩色文字）| 'binary'（Otsu 二值化）
    function cropForOcr(canvas, rect, targetHeight = 64, mode = 'luma') {
        const r = clampRect(rect, canvas);
        if (!r) return null;
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        const scale = Math.max(1, Math.min(6, targetHeight / h));
        const out = document.createElement('canvas');
        out.width = Math.round(w * scale);
        out.height = Math.round(h * scale);
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, r.x0, r.y0, w, h, 0, 0, out.width, out.height);
        const img = ctx.getImageData(0, 0, out.width, out.height);
        const d = img.data;
        const gray = new Uint8Array(d.length / 4);
        let min = 255, max = 0, sum = 0;
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            // 'white'：取 RGB 最小值，只保留白色文字，彩色箭头与深色底一起变暗。
            const g = mode === 'max' ? Math.max(d[i], d[i + 1], d[i + 2])
                : mode === 'white' ? Math.min(d[i], d[i + 1], d[i + 2])
                : Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
            gray[j] = g; sum += g;
            if (g < min) min = g;
            if (g > max) max = g;
        }
        const invert = sum / gray.length < 128;
        const range = Math.max(1, max - min);
        const cut = mode === 'binary' ? otsu(gray) : -1;
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            let v = cut >= 0 ? (gray[j] > cut ? 255 : 0) : Math.round((gray[j] - min) * 255 / range);
            if (invert) v = 255 - v;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        // 四周留白
        const margin = Math.round(out.height * 0.35);
        const framed = document.createElement('canvas');
        framed.width = out.width + margin * 2;
        framed.height = out.height + margin * 2;
        const fctx = framed.getContext('2d');
        fctx.fillStyle = '#fff';
        fctx.fillRect(0, 0, framed.width, framed.height);
        fctx.drawImage(out, margin, margin);
        return framed;
    }

    function otsu(gray) {
        const hist = new Float64Array(256);
        gray.forEach(v => { hist[v]++; });
        const total = gray.length;
        let sumAll = 0;
        for (let i = 0; i < 256; i++) sumAll += i * hist[i];
        let sumB = 0, wB = 0, best = 0, cut = 127;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (!wB) continue;
            const wF = total - wB;
            if (!wF) break;
            sumB += t * hist[t];
            const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
            if (between > best) { best = between; cut = t; }
        }
        return cut;
    }

    function maxChannelInverted(canvas) {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0);
        const img = ctx.getImageData(0, 0, out.width, out.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = 255 - Math.max(d[i], d[i + 1], d[i + 2]);
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
        return out;
    }

    // 折扣区域及其左侧（箭头常在左边）的颜色判断
    function colorSignAt(canvas, bbox) {
        const height = bbox.y1 - bbox.y0;
        const r = clampRect({ x0: bbox.x0 - height * 1.5, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 }, canvas);
        if (!r) return 0;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        return Pair.colorSign(ctx.getImageData(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0).data);
    }

    function collectLines(data) {
        const lines = [];
        (data.blocks || []).forEach(block => (block.paragraphs || []).forEach(para => (para.lines || []).forEach(line => {
            lines.push({ words: (line.words || []).map(w => ({ text: w.text, bbox: w.bbox, confidence: w.confidence })) });
        })));
        return lines;
    }

    const STAGES = { load: '加载识别模型', page: '识别整张图片', fields: '精细识别商品字段' };

    // 一次导入会话。cancel()/dispose() 终止 Worker，未完成的任务以 CancelledError 结束且不返回结果
    // expectedBase：用于售价合理性检查的基础价（页面默认基础价）；传 0 关闭检查
    function createSession({ onProgress = () => {}, expectedBase = 2000 } = {}) {
        let workers = null;
        let runId = 0;
        let stageInfo = { stage: 'load', progress: 0 };

        const report = (stage, progress) => {
            stageInfo = { stage, progress: Math.max(0, Math.min(1, progress)) };
            onProgress({ stage, label: STAGES[stage], progress: stageInfo.progress });
        };

        async function ensureWorkers(id) {
            if (workers) return workers;
            const Tesseract = await loadLibrary();
            const options = {
                workerPath: assetUrl('vendor/tesseract/worker.min.js'),
                corePath: assetUrl('vendor/tesseract/core/'),
                langPath: assetUrl('vendor/tesseract/lang'),
                workerBlobURL: false,
                logger: m => {
                    if (id !== runId) return;
                    if (stageInfo.stage === 'load' && typeof m.progress === 'number') report('load', m.progress * 0.9 + (m.status && m.status.includes('initializ') ? 0.1 : 0));
                }
            };
            const created = await Promise.all([
                Tesseract.createWorker(['chi_sim', 'eng'], Tesseract.OEM.LSTM_ONLY, options),
                Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, options)
            ]);
            if (id !== runId) { created.forEach(w => w.terminate()); throw new CancelledError(); }
            await created[0].setParameters({ preserve_interword_spaces: '1' });
            workers = { text: created[0], digits: created[1] };
            return workers;
        }

        async function readText(worker, image, params) {
            await worker.setParameters(params);
            const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
            return data;
        }

        async function refineField(w, canvas, field, kind) {
            if (!field) return null;
            const b = field.bbox;
            const hgt = b.y1 - b.y0;
            const crop = cropForOcr(canvas, pad(b, hgt * 0.6, hgt * 0.3));
            if (!crop) return null;
            if (kind === 'name') {
                const data = await readText(w.text, crop, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
                return { text: data.text.trim(), confidence: data.confidence };
            }
            // 水平方向只放宽一点：价格左侧紧挨货币图标，放宽过多会多读出一位
            // 价格右侧放宽以免漏掉末位
            const rect = kind === 'price'
                ? { x0: b.x0 - hgt * 0.15, y0: b.y0 - hgt * 0.3, x1: b.x1 + hgt * 0.7, y1: b.y1 + hgt * 0.3 }
                : pad(b, hgt * 0.15, hgt * 0.3);
            return readDigits(w, canvas, rect, kind);
        }

        // 折扣标签：价格上方的深色小面板，白字 + 红/绿三角
        async function readDiscountPill(w, canvas, priceBox) {
            const hgt = priceBox.y1 - priceBox.y0;
            const area = clampRect({ x0: priceBox.x0 - hgt * 1.5, y0: priceBox.y0 - hgt * 2.2, x1: priceBox.x1 + hgt * 0.6, y1: priceBox.y0 - hgt * 0.05 }, canvas);
            if (!area) return null;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
            const panel = Pair.darkPanel({ data: ctx.getImageData(area.x0, area.y0, aw, ah).data, width: aw, height: ah });
            if (!panel) return null;
            const box = { x0: area.x0 + panel.x0, y0: area.y0 + panel.y0, x1: area.x0 + panel.x1, y1: area.y0 + panel.y1 };
            const ph = box.y1 - box.y0;
            // 三角在左侧约一个高度内：颜色判断用左侧，文字识别跳过它
            const tri = clampRect({ x0: box.x0, y0: box.y0, x1: box.x0 + ph * 1.2, y1: box.y1 }, canvas);
            const sign = tri ? Pair.colorSign(ctx.getImageData(tri.x0, tri.y0, tri.x1 - tri.x0, tri.y1 - tri.y0).data) : 0;
            const crop = cropForOcr(canvas, { x0: box.x0 + ph * 0.9, y0: box.y0 - 1, x1: box.x1 + 1, y1: box.y1 + 1 }, 64, 'white');
            if (!crop) return null;
            const data = await readText(w.digits, crop, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.%' });
            const text = data.text.trim();
            let value = P.parseDiscount(text, sign, { requirePercent: false });
            // 小号 % 可能被读成末尾多一位数字（92.79）：去掉末位后再试一次
            if (value === null && /^\d{1,2}\.\d\d$/.test(text)) value = P.parseDiscount(text.slice(0, -1), sign, { requirePercent: false });
            return value;
        }

        // 价格和折扣只用数字模型，限制允许字符；彩色折扣用 RGB 最大值处理
        async function readDigits(w, canvas, rect, kind) {
            const crop = cropForOcr(canvas, rect, 64, kind === 'discount' ? 'max' : 'luma');
            if (!crop) return null;
            const whitelist = kind === 'price' ? '0123456789,' : '0123456789.%+-';
            const data = await readText(w.digits, crop, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist });
            return { text: data.text.trim(), confidence: data.confidence };
        }

        // 同一行中缺少的字段：价格在折扣左侧、折扣在价格右侧，范围限于所属名称条宽度
        function siblingRect(known, nameBox, side) {
            const b = known.bbox, hgt = b.y1 - b.y0;
            const rect = side === 'right'
                ? { x0: b.x1 + hgt * 0.2, y0: b.y0 - hgt * 0.3, x1: nameBox.x1, y1: b.y1 + hgt * 0.3 }
                : { x0: nameBox.x0, y0: b.y0 - hgt * 0.3, x1: b.x0 - hgt * 0.2, y1: b.y1 + hgt * 0.3 };
            return rect.x1 - rect.x0 > hgt ? rect : null;
        }

        async function run(file) {
            const id = ++runId;
            const check = () => { if (id !== runId) throw new CancelledError(); };
            report('load', 0);
            const canvas = await loadImage(file);
            check();
            const w = await ensureWorkers(id);
            check();

            report('page', 0);
            // 整图：取 RGB 最大值并反色，彩色文字（红绿折扣）与白字同样清晰
            const page = await readText(w.text, maxChannelInverted(canvas), { tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
            check();
            let lines = collectLines(page);

            // 名称条：单独裁出逐条识别，替换整图中落在名称条内的文字
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const bars = Pair.findBars({ data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height });
            const inside = (b, bar) => (b.x0 + b.x1) / 2 >= bar.x0 && (b.x0 + b.x1) / 2 <= bar.x1 && (b.y0 + b.y1) / 2 >= bar.y0 && (b.y0 + b.y1) / 2 <= bar.y1;
            const barLines = [];
            for (let i = 0; i < bars.length; i++) {
                check();
                report('page', 0.5 + 0.5 * i / bars.length);
                const bar = bars[i];
                const inset = -(bar.y1 - bar.y0) * 0.1;
                // 候选一：整图识别中落在名称条内的文字（按横坐标拼接，置信度取平均）
                let best = null;
                const pageWords = collectLines(page).flatMap(l => l.words).filter(wd => inside(wd.bbox, bar)).sort((a, b) => a.bbox.x0 - b.bbox.x0);
                if (pageWords.length) {
                    const joined = P.cleanName(pageWords.map(wd => wd.text).join(''));
                    const conf = pageWords.reduce((s, wd) => s + wd.confidence, 0) / pageWords.length;
                    if (joined && P.cjkCount(joined) >= 2) best = { text: joined, confidence: conf };
                }
                if (best && best.confidence >= 80) { barLines.push({ words: [{ text: best.text, bbox: bar, confidence: best.confidence }] }); continue; }
                // 候选二：裁出名称条，依次尝试多种对比度处理，取置信度最高且含中文的结果
                for (const mode of ['luma', 'binary', 'max']) {
                    const crop = cropForOcr(canvas, pad(bar, inset, inset), 72, mode);
                    if (!crop) break;
                    const data = await readText(w.text, crop, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
                    check();
                    const name = P.cleanName(data.text);
                    if (name && P.cjkCount(name) >= 1 && (!best || data.confidence > best.confidence)) best = { text: name, confidence: data.confidence };
                    if (best && best.confidence >= 75 && P.cjkCount(best.text) >= 2) break;
                }
                // 置信度过低的名称留空交给用户填写，不猜测
                // 名称不确定时保留占位，售价和折扣仍可配对到这张卡片
                if (best && best.confidence >= 50) barLines.push({ words: [{ text: best.text, bbox: bar, confidence: best.confidence }] });
                else barLines.push({ words: [{ text: '', bbox: bar, confidence: 0, placeholder: true }] });
            }
            check();
            if (barLines.length) {
                lines = lines.map(l => ({ words: l.words.filter(wd => !bars.some(bar => inside(wd.bbox, bar)) && Pair.isValueWord(wd.text)) })).concat(barLines);
            }
            const items = Pair.pairFields(lines, token => colorSignAt(canvas, token.bbox));
            report('page', 1);

            const results = [];
            for (let i = 0; i < items.length; i++) {
                check();
                report('fields', i / Math.max(1, items.length));
                const item = items[i];
                const f = item._fields;
                // 名称条中的名称已单独识别过；仅整图得到的名称再精细识别
                let name = item.name;
                if (!barLines.length) {
                    const nameRead = await refineField(w, canvas, f.name, 'name');
                    check();
                    if (nameRead && nameRead.confidence >= f.name.confidence) name = P.cleanName(nameRead.text) || name;
                }

                let price = item.price;
                const priceRead = await refineField(w, canvas, f.price, 'price');
                check();
                const refinedPrice = priceRead ? P.parsePrice(priceRead.text) : null;
                // 精细结果只在位数一致时替换整图结果；位数不一致说明裁剪丢字或多读，视为不确定
                if (refinedPrice !== null) {
                    if (price === null) price = refinedPrice;
                    else if (String(refinedPrice).length === String(price).length) price = refinedPrice;
                    else if (f.price.confidence < 85) price = null;
                }

                // 白名单内没有箭头字符：精细结果只取数值，符号来自整图文字或颜色
                const discountFrom = (read, wholeText, sign) => {
                    if (!read) return null;
                    const textSignValue = P.textSign(wholeText) || P.textSign(read.text);
                    if (textSignValue && sign && textSignValue !== sign) return null;
                    return P.parseDiscount(read.text.replace(/[+-]/g, ''), textSignValue || sign);
                };
                let discount = item.discount;
                if (f.discount) {
                    const refined = discountFrom(await refineField(w, canvas, f.discount, 'discount'), f.discount.text, colorSignAt(canvas, f.discount.bbox));
                    check();
                    if (refined !== null) discount = refined;
                }

                // 同一行缺失的字段：在已知字段旁边的区域补读
                if (price === null && f.discount) {
                    const rect = siblingRect(f.discount, f.name.bbox, 'left');
                    const read = rect ? await readDigits(w, canvas, rect, 'price') : null;
                    check();
                    if (read) price = P.parsePrice(read.text);
                }
                if (discount === null && f.price) {
                    discount = await readDiscountPill(w, canvas, f.price.bbox);
                    check();
                }
                if (discount === null && f.price) {
                    const rect = siblingRect(f.price, f.name.bbox, 'right');
                    const read = rect ? await readDigits(w, canvas, rect, 'discount') : null;
                    check();
                    if (read) discount = discountFrom(read, '', colorSignAt(canvas, rect));
                }

                // 售价合理性：与 基础价 × (1 + 折扣) 相差超过 3% 视为误读（多/少一位），留空
                if (price !== null && discount !== null && expectedBase) {
                    const expected = expectedBase * (1 + discount / 100);
                    if (Math.abs(price - expected) > expected * 0.03) price = null;
                }

                results.push({ name: name || null, price, discount });
            }
            report('fields', 1);
            check();
            return results.filter(r => r.name || r.price !== null || r.discount !== null);
        }

        async function stopWorkers() {
            const current = workers;
            workers = null;
            if (current) await Promise.all([current.text.terminate(), current.digits.terminate()]).catch(() => {});
        }

        return {
            run,
            cancel() { runId++; return stopWorkers(); },
            dispose() { runId++; return stopWorkers(); }
        };
    }

    root.OcrRecognizer = { createSession, CancelledError, ACCEPTED_TYPES };
})(typeof self !== 'undefined' ? self : this);
