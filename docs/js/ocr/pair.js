// 字段配对：把 OCR 单词按坐标整理成 名称/售价/折扣 并组合成商品
// 输入 lines: [{ words: [{ text, bbox: {x0,y0,x1,y1}, confidence }] }]
(function (root) {
    'use strict';
    const P = root.OcrParse || (typeof require !== 'undefined' ? require('./parse.js') : null);

    const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
    const cx = b => (b.x0 + b.x1) / 2;
    const cy = b => (b.y0 + b.y1) / 2;
    const h = b => Math.max(1, b.y1 - b.y0);
    const w = b => Math.max(1, b.x1 - b.x0);

    function isDiscountText(text) { return /[%％]/.test(text); }
    function isSignOnly(text) { return /^[-−–—+▲▼↑↓△▽]+$/.test(P.toHalfWidth(text).trim()); }
    function isPriceText(text) { return P.parsePrice(text) !== null && P.cjkCount(text) === 0; }

    // classify word into name, price and discount
    function tokenize(lines) {
        const tokens = [];
        lines.forEach(line => {
            const words = (line.words || []).filter(wd => String(wd.text || '').trim());
            let name = null;
            let pendingSign = null;
            const flushName = () => {
                if (name) {
                    const clean = P.cleanName(name.text);
                    if (clean && P.cjkCount(clean) >= 1) tokens.push({ type: 'name', text: clean, bbox: name.bbox, confidence: name.confidence });
                }
                name = null;
            };
            (line.words || []).filter(wd => wd.placeholder).forEach(wd => {
                tokens.push({ type: 'name', text: null, bbox: wd.bbox, confidence: 0 });
            });
            words.forEach(wd => {
                const text = String(wd.text).trim();
                if (isSignOnly(text)) { flushName(); pendingSign = wd; return; }
                if (isDiscountText(text)) {
                    flushName();
                    const bbox = pendingSign ? union(pendingSign.bbox, wd.bbox) : wd.bbox;
                    tokens.push({ type: 'discount', text: (pendingSign ? pendingSign.text : '') + text, bbox, confidence: wd.confidence });
                    pendingSign = null;
                    return;
                }
                pendingSign = null;
                if (isPriceText(text)) { flushName(); tokens.push({ type: 'price', text, bbox: wd.bbox, confidence: wd.confidence }); return; }
                const gap = name ? wd.bbox.x0 - name.bbox.x1 : 0;
                if (name && gap > 1.5 * h(wd.bbox)) flushName();
                if (name) { name.text += text; name.bbox = union(name.bbox, wd.bbox); name.confidence = Math.min(name.confidence, wd.confidence); }
                else name = { text, bbox: wd.bbox, confidence: wd.confidence };
            });
            flushName();
        });
        return tokens;
    }

    // check if number and name are in the same colomn
    function sameColumn(token, name) {
        const slack = Math.max(w(name.bbox) * 0.5, h(name.bbox) * 2);
        return cx(token.bbox) >= name.bbox.x0 - slack && cx(token.bbox) <= name.bbox.x1 + slack;
    }

    // 主方向：数值通常都在名称的同一侧（上方或下方）。按最近名称投票
    function dominantDirection(values, names) {
        let up = 0, down = 0;
        values.forEach(t => {
            let best = null;
            names.forEach(n => {
                if (!sameColumn(t, n)) return;
                const d = Math.abs(cy(t.bbox) - cy(n.bbox));
                if (!best || d < best.d) best = { d, dir: cy(t.bbox) < cy(n.bbox) ? 'up' : 'down' };
            });
            if (best) best.dir === 'up' ? up++ : down++;
        });
        if (up === down) return null;
        return up > down ? 'up' : 'down';
    }

    // match each number to its assigned name
    function assign(values, names, direction) {
        const result = new Map();
        values.forEach(t => {
            const scored = names.map((n, i) => {
                if (!sameColumn(t, n)) return null;
                const dy = cy(t.bbox) - cy(n.bbox);
                if (direction === 'up' && dy > 0) return null;
                if (direction === 'down' && dy < 0) return null;
                const maxDist = 10 * h(n.bbox);
                const dist = Math.hypot(dy, (cx(t.bbox) - cx(n.bbox)) * 0.5);
                if (dist > maxDist) return null;
                return { i, dist };
            }).filter(Boolean).sort((a, b) => a.dist - b.dist);
            if (!scored.length) return;
            if (scored[1] && scored[1].dist - scored[0].dist < 0.15 * scored[0].dist + 2) return;
            const list = result.get(scored[0].i) || [];
            list.push({ token: t, dist: scored[0].dist });
            result.set(scored[0].i, list);
        });
        return result;
    }

    // if a name has multiple possible numbers, pick one
    function pickOne(list) {
        if (!list || !list.length) return null;
        const sorted = list.slice().sort((a, b) => a.dist - b.dist);
        if (sorted[1] && sorted[1].dist - sorted[0].dist < 0.15 * sorted[0].dist + 2) return null;
        return sorted[0].token;
    }


    function mergeDigitWords(lines) {
        const isDigits = wd => /^\d+$/.test(P.toHalfWidth(String(wd.text || '').trim()));
        const digits = [];
        const rest = lines.map(l => ({ words: (l.words || []).filter(wd => { if (!wd.placeholder && isDigits(wd)) { digits.push({ ...wd, text: P.toHalfWidth(String(wd.text).trim()) }); return false; } return true; }) }));
        digits.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const used = new Set();
        const merged = [];
        digits.forEach((wd, i) => {
            if (used.has(i)) return;
            let cur = { ...wd, bbox: { ...wd.bbox } };
            for (let j = i + 1; j < digits.length; j++) {
                if (used.has(j)) continue;
                const nx = digits[j];
                const overlap = Math.min(cur.bbox.y1, nx.bbox.y1) - Math.max(cur.bbox.y0, nx.bbox.y0);
                const gap = nx.bbox.x0 - cur.bbox.x1;
                if (overlap > 0.6 * Math.min(h(cur.bbox), h(nx.bbox)) && gap < 0.6 * h(cur.bbox) && gap > -0.5 * h(cur.bbox)) {
                    cur = { text: cur.text + nx.text, bbox: union(cur.bbox, nx.bbox), confidence: Math.min(cur.confidence, nx.confidence) };
                    used.add(j);
                }
            }
            merged.push(cur);
        });
        return rest.concat(merged.map(wd => ({ words: [wd] })));
    }

    function pairFields(lines, colorSignOf = () => 0) {
        const tokens = tokenize(mergeDigitWords(lines));
        const names = tokens.filter(t => t.type === 'name');
        const prices = tokens.filter(t => t.type === 'price');
        const discounts = tokens.filter(t => t.type === 'discount');
        if (!names.length) return [];
        const direction = dominantDirection(prices.concat(discounts), names);
        const priceMap = assign(prices, names, direction);
        const discountMap = assign(discounts, names, direction);
        return names.map((n, i) => {
            const priceToken = pickOne(priceMap.get(i));
            const discountToken = pickOne(discountMap.get(i));
            return {
                name: n.text,
                price: priceToken ? P.parsePrice(priceToken.text) : null,
                discount: discountToken ? P.parseDiscount(discountToken.text, colorSignOf(discountToken)) : null,
                _fields: { name: n, price: priceToken, discount: discountToken }
            };
        });
    }

    // 像素 → 涨跌符号。data 为 RGBA 数组。红色多 = +1，绿色多 = -1。
    const RED_IS_UP = true;
    function colorSign(data) {
        let red = 0, green = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max < 0.3 || (max - min) / max < 0.35) continue;
            let hue;
            if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
            else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
            else hue = 60 * ((r - g) / (max - min)) + 240;
            if (hue < 25 || hue > 335) red++;
            else if (hue > 75 && hue < 165) green++;
        }
        const total = data.length / 4;
        if (red + green < Math.max(6, total * 0.01)) return 0;
        if (red > green * 2) return RED_IS_UP ? 1 : -1;
        if (green > red * 2) return RED_IS_UP ? -1 : 1;
        return 0;
    }

    // 浅色名称条定位：亮度 > 阈值的像素按行聚成横带，带内按列切成矩形。
    // 输入 { data, width, height }（RGBA），返回 [{x0,y0,x1,y1}]，不依赖固定分辨率。
    // dark: true 时找深色底名称条（浅色文字）。
    function findLightBars(image, { threshold = 185, dark = false } = {}) {
        const { data, width: W, height: H } = image;
        const bright = new Uint8Array(W * H);
        for (let i = 0, j = 0; j < bright.length; i += 4, j++) {
            const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            bright[j] = (dark ? luma < threshold : luma > threshold) ? 1 : 0;
        }
        // 卡片尺寸随画面宽度缩放：条高限制按宽度计算，不受截图高度（是否含顶部栏）影响。
        const minBarW = Math.max(40, W * 0.06), minBarH = Math.max(8, W * 0.008), maxBarH = Math.max(minBarH + 1, W * 0.04);
        const rowFill = new Float32Array(H);
        for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += bright[y * W + x]; rowFill[y] = n / W; }
        const bands = [];
        let start = -1;
        for (let y = 0; y <= H; y++) {
            const on = y < H && rowFill[y] > 0.08;
            if (on && start < 0) start = y;
            if (!on && start >= 0) { if (y - start >= minBarH && y - start <= maxBarH) bands.push([start, y]); start = -1; }
        }
        const bars = [];
        bands.forEach(([y0, y1]) => {
            const h = y1 - y0;
            // 名称文字会让列变暗，但名称条上下留白仍为亮色：列亮度 > 25% 即算条内。
            const runs = [];
            let x0 = -1;
            // 文字会占满条高的大部分：列内只要有少量底色像素就算条内，字间断口后面再合并。
            for (let x = 0; x <= W; x++) {
                let n = 0;
                if (x < W) for (let y = y0; y < y1; y++) n += bright[y * W + x];
                const on = x < W && n / h > 0.12;
                if (on && x0 < 0) x0 = x;
                if (!on && x0 >= 0) { runs.push([x0, x]); x0 = -1; }
            }
            // 合并字间断口（< 0.6 条高），卡片之间的缝隙更宽，不会被合并。
            const merged = [];
            runs.forEach(r => {
                const last = merged[merged.length - 1];
                if (last && r[0] - last[1] < h * 0.6) last[1] = r[1];
                else merged.push(r.slice());
            });
            merged.forEach(([a, b]) => {
                if (b - a >= minBarW && (b - a) / h >= 2) bars.push({ x0: a, y0, x1: b, y1 });
            });
        });
        return bars;
    }


    function isValueWord(text) {
        const t = String(text || '').trim();
        return isDiscountText(t) || isSignOnly(t) || isPriceText(t) || /^\d$/.test(P.toHalfWidth(t));
    }

    function findBars(image) {
        return dedupeBars(findLightBars(image).concat(findLightBars(image, { threshold: 100, dark: true })));
    }

    // 浅色条与深色条可能是同一个名称条（深色底 + 白字）：两者重叠时只保留面积较大者，避免一个商品有两个名称。
    // 另外去掉横跨多个名称条的条带（名称条下方的亮色分隔线），它不是名称。
    function dedupeBars(bars) {
        const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
        const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
        const near = (a, b) => Math.abs(cy(a) - cy(b)) < Math.max(h(a), h(b));
        const spans = bars.filter(b => bars.filter(o => o !== b && near(o, b) && cx(o) > b.x0 && cx(o) < b.x1 && w(o) < w(b) * 0.6).length >= 2);
        const rest = bars.filter(b => !spans.includes(b)).sort((a, b) => area(b) - area(a));
        const kept = [];
        rest.forEach(b => { if (!kept.some(k => inter(k, b) > 0.5 * Math.min(area(k), area(b)))) kept.push(b); });
        return kept.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    }

    // 倾斜角估计（度）：名称条、卡片边缘是长横线。取横向边缘像素（上下亮度差大），按不同角度做行投影，
    // 投影越"尖"（行和的平方和越大）说明越接近水平。只用边缘而不用整片深色区域，避免显示器黑边主导结果。
    // 只在 ±maxDeg 内搜索，图像先缩小以加快速度。
    function estimateSkew(image, { maxDeg = 5, step = 0.25 } = {}) {
        const { data, width: W, height: H } = image;
        const ds = Math.max(1, Math.round(W / 900));
        const w2 = Math.floor(W / ds), h2 = Math.floor(H / ds);
        const L = new Float32Array(w2 * h2);
        for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
            const i = ((y * ds) * W + x * ds) * 4;
            L[y * w2 + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const pts = [];
        for (let y = 1; y < h2 - 1; y++) for (let x = 1; x < w2 - 1; x++) {
            const gy = Math.abs(L[(y + 1) * w2 + x] - L[(y - 1) * w2 + x]);
            const gx = Math.abs(L[y * w2 + x + 1] - L[y * w2 + x - 1]);
            if (gy > 60 && gy > 2 * gx) pts.push(x, y);
        }
        if (pts.length < 200) return 0;
        const score = deg => {
            const t = Math.tan(deg * Math.PI / 180);
            const rows = new Float64Array(h2 + w2 * 2 + 2);
            const off = w2 + 1;
            for (let k = 0; k < pts.length; k += 2) rows[Math.round(pts[k + 1] - pts[k] * t) + off]++;
            let s = 0;
            for (let i = 0; i < rows.length; i++) s += rows[i] * rows[i];
            return s;
        };
        let best = 0, bestScore = score(0);
        for (let d = -maxDeg; d <= maxDeg + 1e-9; d += step) {
            const s = score(d);
            if (s > bestScore) { bestScore = s; best = d; }
        }
        // 在最佳角附近细化
        for (let d = best - step; d <= best + step + 1e-9; d += step / 5) {
            const s = score(d);
            if (s > bestScore) { bestScore = s; best = d; }
        }
        return Math.round(best * 100) / 100;
    }

    // 区域内的深色面板（如折扣标签底色）：深色像素占比 > 30% 的行列范围。找不到返回 null。
    function darkPanel(image, { threshold = 90 } = {}) {
        const { data, width: W, height: H } = image;
        const cols = new Uint32Array(W), rows = new Uint32Array(H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < threshold) { cols[x]++; rows[y]++; }
        }
        const span = (arr, total) => {
            let a = -1, b = -1;
            arr.forEach((n, i) => { if (n / total > 0.3) { if (a < 0) a = i; b = i + 1; } });
            return a < 0 ? null : [a, b];
        };
        const xs = span(cols, H), ys = span(rows, W);
        if (!xs || !ys || xs[1] - xs[0] < 8 || ys[1] - ys[0] < 6) return null;
        return { x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] };
    }

    const api = { tokenize, pairFields, colorSign, dominantDirection, findLightBars, findBars, dedupeBars, estimateSkew, darkPanel, isValueWord, mergeDigitWords };
    root.OcrPair = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
