// 在浏览器中运行：msedge --headless --dump-dom tests/unit.html
(function () {
    const results = [];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function test(name, fn) {
        try { fn(); results.push('ok   ' + name); }
        catch (e) { results.push('FAIL ' + name + ' :: ' + e.message); }
    }
    function expect(actual, expected) {
        if (!eq(actual, expected)) throw new Error('expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
    }
    const P = OcrParse, M = OcrMerge, Pair = OcrPair;

    // ---------- 数字解析 ----------
    test('price: plain', () => expect(P.parsePrice('1367'), 1367));
    test('price: thousands comma & full width', () => expect(P.parsePrice('１,３６７'), 1367));
    test('price: OCR confusions', () => expect(P.parsePrice('l3O7'), 1307));
    test('price: currency icon noise', () => expect(P.parsePrice('¥1367'), 1367));
    test('price: rejects text', () => expect(P.parsePrice('竹笋'), null));
    test('price: rejects single digit', () => expect(P.parsePrice('7'), null));
    test('price: rejects empty', () => expect(P.parsePrice(''), null));
    test('discount: negative with minus', () => expect(P.parseDiscount('-31.6%'), -31.6));
    test('discount: unicode minus', () => expect(P.parseDiscount('−31.6%'), -31.6));
    test('discount: plus', () => expect(P.parseDiscount('+12.5%'), 12.5));
    test('discount: arrows', () => expect([P.parseDiscount('▲8%'), P.parseDiscount('▼8%')], [8, -8]));
    test('discount: color sign only', () => expect([P.parseDiscount('31.6%', -1), P.parseDiscount('31.6%', 1)], [-31.6, 31.6]));
    test('discount: no sign info -> null', () => expect(P.parseDiscount('31.6%'), null));
    test('discount: text/color conflict -> null', () => expect(P.parseDiscount('+31.6%', -1), null));
    test('discount: zero needs no sign', () => expect(P.parseDiscount('0%'), 0));
    test('discount: requires percent', () => expect(P.parseDiscount('-31.6'), null));
    test('discount: rejects >= 100', () => expect(P.parseDiscount('-100%'), null));
    test('discount: rejects two decimals', () => expect(P.parseDiscount('-3.16%'), null));
    test('discount: full width', () => expect(P.parseDiscount('－３１．６％'), -31.6));
    test('discount: misread arrow prefix uses color', () => expect([P.parseDiscount('V31.6%', -1), P.parseDiscount('A12%', 1), P.parseDiscount('了10%', -1), P.parseDiscount('A12%')], [-31.6, 12, -10, null]));
    test('discount: O as zero', () => expect(P.parseDiscount('-1O.5%'), -10.5));
    test('name: cleans spaces/punct', () => expect(P.cleanName(' 冬虫 夏笋 货组。'), '冬虫夏笋货组'));
    test('name: too short -> null', () => expect(P.cleanName('冬'), null));

    // ---------- 字段配对 ----------
    const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, bbox: { x0, y0, x1, y1 }, confidence });
    // 两行三列卡片：名称条在下方，价格与折扣在名称上方
    const grid = [];
    const cards = [
        ['冬虫夏笋货组', '1367', '-31.6%'], ['锚点矿石', '2240', '+12%'], ['竹笋', '1800', '-10%'],
        ['工业零件', '2100', '+5%'], ['精炼铁锭', '1950', '-2.5%'], ['荧光苔藓', '2400', '+20%']
    ];
    cards.forEach(([name, price, disc], i) => {
        const col = i % 3, row = Math.floor(i / 3);
        const x = 100 + col * 400, y = 100 + row * 500;
        grid.push({ words: [word(price, x + 40, y + 300, x + 160, y + 340), word(disc, x + 200, y + 300, x + 320, y + 340)] });
        grid.push({ words: [word(name, x + 20, y + 380, x + 340, y + 420)] });
    });
    test('pair: grid matches each card', () => {
        const items = Pair.pairFields(grid).map(({ name, price, discount }) => ({ name, price, discount }));
        expect(items, cards.map(([name, price, disc]) => ({ name, price: Number(price), discount: P.parseDiscount(disc) })));
    });
    test('pair: no cross-card price when one card misses price', () => {
        const lines = grid.map(l => ({ words: l.words.filter(w => w.text !== '2240') }));
        const items = Pair.pairFields(lines);
        expect(items[1].price, null);
        expect(items[0].price, 1367);
        expect(items[2].price, 1800);
    });
    test('pair: tokenize merges split name words', () => {
        const tokens = Pair.tokenize([{ words: [word('冬虫', 0, 0, 60, 30), word('夏笋货组', 64, 0, 180, 30)] }]);
        expect(tokens.map(t => [t.type, t.text]), [['name', '冬虫夏笋货组']]);
    });
    test('pair: sign word joins following discount', () => {
        const tokens = Pair.tokenize([{ words: [word('-', 0, 0, 10, 30), word('31.6%', 14, 0, 90, 30)] }]);
        expect(tokens.map(t => [t.type, t.text]), [['discount', '-31.6%']]);
    });
    test('pair: color sign used when text has none', () => {
        const lines = [{ words: [word('1367', 40, 300, 160, 340), word('31.6%', 200, 300, 320, 340)] }, { words: [word('冬虫夏笋货组', 20, 380, 340, 420)] }];
        const items = Pair.pairFields(lines, () => -1);
        expect(items[0].discount, -31.6);
    });
    test('pair: placeholder name still pairs values', () => {
        const lines = [{ words: [word('2400', 40, 300, 160, 340), word('+20%', 200, 300, 320, 340)] }, { words: [{ text: '', bbox: { x0: 20, y0: 380, x1: 340, y1: 420 }, confidence: 0, placeholder: true }] }];
        const items = Pair.pairFields(lines).map(({ name, price, discount }) => ({ name, price, discount }));
        expect(items, [{ name: null, price: 2400, discount: 20 }]);
    });
    test('pair: split digit words merge (385 + 3 -> 3853)', () => {
        const lines = [
            { words: [word('385', 176, 263, 224, 283)] },
            { words: [word('3', 227, 263, 241, 283)] },
            { words: [word('龙泡泡浮空艇货组', 60, 316, 240, 336)] }
        ];
        expect(Pair.pairFields(lines)[0].price, 3853);
    });
    test('pair: digits of neighbouring cards stay separate', () => {
        const lines = [{ words: [word('1865', 180, 565, 240, 586), word('1094', 396, 565, 458, 585)] }];
        const merged = Pair.mergeDigitWords(lines).flatMap(l => l.words).map(wd => wd.text).sort();
        expect(merged, ['1094', '1865']);
    });
    test('pair: empty input', () => expect(Pair.pairFields([]), []));
    test('colorSign: red/green/gray', () => {
        const fill = (r, g, b, n = 100) => { const a = []; for (let i = 0; i < n; i++) a.push(r, g, b, 255); return a; };
        expect([Pair.colorSign(fill(220, 40, 50)), Pair.colorSign(fill(30, 180, 90)), Pair.colorSign(fill(128, 128, 128))], [1, -1, 0]);
    });

    // ---------- 导入合并 ----------
    const products = [{ name: '冬虫夏笋货组', basePrice: 2000, discount: 0 }, { name: '竹笋', basePrice: 1500, discount: 3 }];
    test('match: exact', () => expect(M.matchProduct('竹笋', products).exactIndex, 1));
    test('match: near candidates, no silent replace', () => {
        const m = M.matchProduct('冬虫夏笋货组。', products);
        expect([m.exactIndex, m.candidates], [-1, ['冬虫夏笋货组']]);
    });
    test('match: empty library', () => expect(M.matchProduct('竹笋', []), { exactIndex: -1, candidates: [] }));
    test('rows: checked only when name and discount valid', () => {
        const rows = M.buildRows([{ name: '竹笋', price: null, discount: -5 }, { name: '竹笋2', price: 1000, discount: null }, { name: null, price: 1000, discount: 2 }], products);
        expect(rows.map(r => r.checked), [true, false, false]);
        expect(rows[1].discount, '');
    });
    test('errors: duplicate names among checked rows', () => {
        const rows = [{ id: 0, checked: true, name: 'A', discount: 1 }, { id: 1, checked: true, name: 'A ', discount: 2 }, { id: 2, checked: false, name: 'A', discount: 2 }];
        expect(M.rowErrors(rows), { 0: '名称重复', 1: '名称重复' });
    });
    test('errors: invalid discount & empty name', () => {
        const rows = [{ id: 0, checked: true, name: 'A', discount: '' }, { id: 1, checked: true, name: ' ', discount: 1 }];
        expect(M.rowErrors(rows), { 0: '折扣无效', 1: '请填写名称' });
    });
    test('plan: update keeps basePrice, add uses default, unchecked ignored', () => {
        const rows = [
            { id: 0, checked: true, name: '竹笋', price: 1400, discount: -6.5 },
            { id: 1, checked: true, name: ' 新商品 ', price: null, discount: 4 },
            { id: 2, checked: false, name: '冬虫夏笋货组', price: 1367, discount: -31.6 }
        ];
        expect(M.planImport(rows, products, 2000), { updates: [{ index: 1, discount: -6.5 }], additions: [{ name: '新商品', basePrice: 2000, discount: 4 }] });
    });
    test('plan: saved formula example 1367 / -31.6% -> 1368', () => {
        const { additions } = M.planImport([{ id: 0, checked: true, name: 'X', price: 1367, discount: -31.6 }], [], 2000);
        const p = additions[0];
        expect(Object.keys(p), ['name', 'basePrice', 'discount']);
        expect(Math.round(p.basePrice * (1 + p.discount / 100)), 1368);
    });
    test('priceMismatch: tolerance 2', () => {
        expect(M.priceMismatch({ name: 'X', price: 1367, discount: -31.6 }, [], 2000), false);
        expect(M.priceMismatch({ name: 'X', price: 1500, discount: -31.6 }, [], 2000), true);
        expect(M.priceMismatch({ name: 'X', price: null, discount: -31.6 }, [], 2000), false);
    });

    // ---------- 名称条去重 ----------
    test('dedupeBars: overlapping light/dark bar keeps larger', () => expect(
        Pair.dedupeBars([{ x0: 139, y0: 1192, x1: 380, y1: 1222 }, { x0: 98, y0: 1185, x1: 419, y1: 1230 }]),
        [{ x0: 98, y0: 1185, x1: 419, y1: 1230 }]));
    test('dedupeBars: drops strip spanning several bars', () => expect(
        Pair.dedupeBars([{ x0: 98, y0: 1185, x1: 419, y1: 1230 }, { x0: 446, y0: 1185, x1: 772, y1: 1230 }, { x0: 176, y0: 1224, x1: 2600, y1: 1266 }]),
        [{ x0: 98, y0: 1185, x1: 419, y1: 1230 }, { x0: 446, y0: 1185, x1: 772, y1: 1230 }]));
    test('dedupeBars: separate bars untouched', () => expect(
        Pair.dedupeBars([{ x0: 446, y0: 10, x1: 772, y1: 50 }, { x0: 98, y0: 10, x1: 419, y1: 50 }]),
        [{ x0: 98, y0: 10, x1: 419, y1: 50 }, { x0: 446, y0: 10, x1: 772, y1: 50 }]));

    // ---------- 倾斜估计 ----------
    // 白底上画几条按 deg 倾斜的黑色横条
    function tiltedBars(deg, W = 900, H = 600) {
        const data = new Uint8ClampedArray(W * H * 4).fill(255);
        const t = Math.tan(deg * Math.PI / 180);
        [150, 300, 450].forEach(y0 => {
            for (let x = 50; x < W - 50; x++) for (let k = 0; k < 20; k++) {
                const y = Math.round(y0 + x * t) + k;
                if (y >= 0 && y < H) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
            }
        });
        return { data, width: W, height: H };
    }
    test('estimateSkew: level image is 0', () => expect(Pair.estimateSkew(tiltedBars(0)), 0));
    test('estimateSkew: detects +1.5 deg', () => { const d = Pair.estimateSkew(tiltedBars(1.5)); if (Math.abs(d - 1.5) > 0.15) throw new Error('got ' + d); });
    test('estimateSkew: detects -2 deg', () => { const d = Pair.estimateSkew(tiltedBars(-2)); if (Math.abs(d + 2) > 0.15) throw new Error('got ' + d); });
    test('estimateSkew: blank image is 0', () => expect(Pair.estimateSkew({ data: new Uint8ClampedArray(400 * 300 * 4).fill(255), width: 400, height: 300 }), 0));

    const failed = results.filter(r => r.startsWith('FAIL')).length;
    document.getElementById('out').textContent = results.join('\n') + '\n' + (failed ? 'FAILED ' + failed : 'ALL PASSED ' + results.length);
})();
