// Parse name and number from ocr results
(function (root) {
    'use strict';

    // Turn OCR mistake to digits
    const DIGIT_FIXES = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', Z: '2', z: '2', S: '5', s: '5', B: '8', g: '9' };

    // 全角转半角
    function toHalfWidth(text) {
        return String(text || '')
            .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
            .replace(/　/g, ' ');
    }

    // Turn OCR mistake to digits
    function fixDigits(text) {
        return text.replace(/[OoDQIl|iZzSsBg]/g, ch => DIGIT_FIXES[ch]);
    }


    function parsePrice(text) {
        let s = toHalfWidth(text).replace(/[\s,，'`]/g, '');
        s = fixDigits(s);

        const match = s.match(/^\D{0,2}(\d{2,6})\D{0,2}$/);
        if (!match) return null;
        const value = Number(match[1]);
        return value > 0 ? value : null;
    }

    // parse sign from price to determine positive or negative price
    // 1  positive
    // -1 negative
    // 0 no change
    function textSign(text) {
        const s = toHalfWidth(text);

        if (/[-−–—▼↓▽]/.test(s)) return -1;
        if (/[+▲↑△]/.test(s)) return 1;
        return 0;
    }


    // colorSign: sign from colour to determine positive or negative
    // textsign and colorsign must be matched
    // requirePercent: whether % is must
    function parseDiscount(text, colorSign = 0, { requirePercent = true } = {}) {
        let s = toHalfWidth(text).replace(/\s/g, '');

        // check if % exists, and ignore characters after %
        if (/%/.test(s)) s = s.slice(0, s.lastIndexOf('%'));
        else if (requirePercent) return null;

        // ignore sign before the price
        s = s.replace(/^[^\d+\-−–—▲▼↑↓△▽]+/, '');

        const sign = textSign(s);  // sign from price, instead of colour
        const digits = fixDigits(s.replace(/[-−–—▼↓▽+▲↑△]/g, '')).replace(/,/g, '.');
        const match = digits.match(/^(\d{1,2})(?:\.(\d))?$/);  // only accept 1-2 digit integer + optional 1 decimal place
        if (!match) return null;

        const magnitude = Number(match[2] === undefined ? match[1] : match[1] + '.' + match[2]);
        if (magnitude === 0) return 0;

        if (sign && colorSign && sign !== colorSign) return null;

        const finalSign = sign || colorSign;
        if (!finalSign) return null;

        return finalSign * magnitude;
    }

    // clean up name string, such as space, non-chinese or non-english characters
    function cleanName(text) {
        const s = toHalfWidth(text)
            .replace(/[\s·•]/g, '')
            .replace(/[^一-鿿A-Za-z0-9\-（）()]/g, '');
        return s.length >= 2 ? s : null;
    }

    // count chinese characters
    function cjkCount(text) {
        return (String(text || '').match(/[一-鿿]/g) || []).length;
    }

    const api = { toHalfWidth, parsePrice, parseDiscount, textSign, cleanName, cjkCount };
    root.OcrParse = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
