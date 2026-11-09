// code to merge ocr parsed results with existing data
(function (root) {
    'use strict';

    const P = root.OcrParse || (typeof require !== 'undefined' ? require('./parse.js') : null);
    const halfWidth = text => P.toHalfWidth(text).replace(/\s/g, '');

    // lavenshtein distance between two strings
    function levenshtein(a, b) {
        const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            let diag = prev[0];
            prev[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const tmp = prev[j];
                prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
                diag = tmp;
            }
        }
        return prev[b.length];
    }
    
    // similarity between two strings
    function similarity(a, b) {
        a = halfWidth(a); b = halfWidth(b);
        if (!a || !b) return 0;
        return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    }

    // return index of exact matched results with existing data, otherwise return 3 candidates with similarity > 0.5
    function matchProduct(name, products) {
        const trimmed = String(name || '').trim();
        const exactIndex = trimmed ? products.findIndex(p => p.name === trimmed) : -1;
        if (exactIndex !== -1 || !trimmed) return { exactIndex, candidates: [] };  // return exact matched data

        const candidates = products
            .map(p => ({ name: p.name, score: similarity(trimmed, p.name) }))
            .filter(c => c.score >= 0.5)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(c => c.name);
        return { exactIndex, candidates };
    }

    function isValidDiscount(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > -100 && value < 100;
    }

    function isValidName(name) {
        return typeof name === 'string' && name.trim().length > 0;
    }

    // turn ocr results into preview rows
    function buildRows(items, products) {
        return items.map((item, index) => {
            const name = item.name || '';
            return {
                id: index,
                checked: isValidName(name) && isValidDiscount(item.discount),
                name,
                price: item.price,
                discount: item.discount === null ? '' : item.discount,
                candidates: matchProduct(name, products).candidates
            };
        });
    }

    // check previewed rows
    function rowErrors(rows) {
        const errors = {};
        const checked = rows.filter(r => r.checked);
        const counts = {};

        checked.forEach(r => {
            const key = String(r.name || '').trim();
            if (key) counts[key] = (counts[key] || 0) + 1;
        });

        checked.forEach(r => {
            const key = String(r.name || '').trim();
            if (!key) errors[r.id] = '请填写名称';
            else if (counts[key] > 1) errors[r.id] = '名称重复';
            else if (!isValidDiscount(r.discount)) errors[r.id] = '折扣无效';
        });
        return errors;
    }

    function planImport(rows, products, defaultBasePrice) {
        // import will be updates and addition operations
        const updates = [];
        const additions = [];

        rows.filter(r => r.checked).forEach(r => {
            const name = r.name.trim();
            const index = products.findIndex(p => p.name === name);
            if (index !== -1) updates.push({ index, discount: r.discount });
            else additions.push({ name, basePrice: defaultBasePrice, discount: r.discount });
        });
        return { updates, additions };
    }

    // check price mismatch, for ocr recognised price and calculated price
    function priceMismatch(row, products, defaultBasePrice) {
        if (typeof row.price !== 'number' || !isValidDiscount(row.discount)) return false;
        const existing = products.find(p => p.name === String(row.name || '').trim());
        const base = existing ? existing.basePrice : defaultBasePrice;
        return Math.abs(base * (1 + row.discount / 100) - row.price) > 2;
    }

    const api = { similarity, matchProduct, buildRows, rowErrors, planImport, priceMismatch, isValidDiscount };
    root.OcrMerge = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
