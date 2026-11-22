// Continuous capture domain logic. No MediaStream, Worker or Vue state lives here.
(function (root) {
    'use strict';

    // Recognition thresholds shared by the engine, the controller and the review UI.
    const TUNING = Object.freeze({
        // Fingerprints are grids of TILE_SIZE × TILE_SIZE grayscale tiles.
        TILE_SIZE: 12,
        // Largest per-tile mean gray difference (0-255) at which two samples still show the same screen.
        STABLE_DISTANCE: 5.1,
        // Consecutive similar samples before a screen is read.
        STABLE_SAMPLES: 3,
        // OCR attempts per stable screen. The last attempt is accepted even without a matching repeat.
        MAX_ROUNDS: 3,
        // Samples to wait after one OCR attempt before starting the next.
        ATTEMPT_SPACING: 2,
        // A repeated read confirms only when its sample is at least this far from the previous evidence.
        CONFIRM_SPACING: 2,
        // Keep a confirmed detail through a short page animation, until the next page is read.
        TRANSITION_GRACE_MS: 2000,
        // The friend-page title can appear before its rows finish loading.
        FRIEND_LOAD_GRACE_MS: 10000,
        // Allowed gap, in percentage points, between the computed and the displayed "对比本地" percent.
        PERCENT_TOLERANCE: 0.2,
        // Allowed gap between the in-game local price and the calculator's own price.
        LOCAL_PRICE_TOLERANCE: 2,
        // Review rows kept per product when candidates conflict, and in total.
        MAX_CANDIDATES_PER_PRODUCT: 2,
        MAX_ROWS: 200,
        // Floating-point slack when checking that a normalized rect stays inside the frame.
        RECT_EPSILON: 0.001
    });

    const rect = (x, y, w, h) => ({ x, y, w, h });
    const defaultLayout = () => ({
        version: 1,
        aspect: null,
        noScroll: false,
        content: rect(0, 0, 1, 1),
        detail: {
            title: rect(.03, .015, .16, .055),
            name: rect(.326, .116, .31, .044),
            localLabel: rect(.695, .228, .075, .04),
            local: rect(.905, .226, .057, .041)
        },
        friend: {
            title: rect(.03, .002, .15, .057),
            name: rect(.390, .344, .23, .05),
            price: rect(.676, .344, .049, .05),
            percent: rect(.795, .344, .05, .05),
            top: rect(.978, .323, .009, .525)
        }
    });
    const validRect = r => r && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k])) &&
        r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 &&
        r.x + r.w <= 1 + TUNING.RECT_EPSILON && r.y + r.h <= 1 + TUNING.RECT_EPSILON;
    function validLayout(l) {
        const validAspect = l && (l.aspect === null || typeof l.aspect === 'number' && Number.isFinite(l.aspect) && l.aspect > 0);
        return l && l.version === 1 && validAspect && typeof l.noScroll === 'boolean' && validRect(l.content) &&
            ['detail', 'friend'].every(p => l[p] && Object.keys(defaultLayout()[p]).every(k => validRect(l[p][k])));
    }
    function absoluteRect(layout, r, frame) {
        const c = layout.content;
        return {
            x0: (c.x + r.x * c.w) * frame.width,
            y0: (c.y + r.y * c.h) * frame.height,
            x1: (c.x + (r.x + r.w) * c.w) * frame.width,
            y1: (c.y + (r.y + r.h) * c.h) * frame.height
        };
    }
    const validPrice = n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
    function parsePrice(text) {
        // Deliberately do not guess O/0 or I/1: repeatable ambiguity still needs review.
        const s = root.OcrParse.toHalfWidth(text).trim().replace(/[,，]/g, '');
        return /^\d{1,9}$/.test(s) && validPrice(Number(s)) ? Number(s) : null;
    }
    const friendName = text => root.OcrParse.toHalfWidth(text).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    function parsePercent(text, sign = 0) {
        let s = root.OcrParse.toHalfWidth(text).replace(/\s/g, '');
        if (!/^[+\-▲▼↑↓]?\d+(\.\d+)?%?$/.test(s)) return null;
        const explicit = /^[+▲↑]/.test(s) ? 1 : /^[-▼↓]/.test(s) ? -1 : 0;
        if (explicit && sign && explicit !== sign) return null;
        const n = Number(s.replace(/[+\-▲▼↑↓%]/g, ''));
        return n === 0 ? 0 : (explicit || sign) ? n * (explicit || sign) : null;
    }
    function friendPrice(product, friend) {
        if (friend.source === 'game-capture') {
            const q = friend.quotes && Object.prototype.hasOwnProperty.call(friend.quotes, product.name)
                ? friend.quotes[product.name]
                : null;
            return q && validPrice(q.price) ? q.price : null;
        }
        const discount = (friend.discounts || {})[product.name] || 0;
        const value = product.basePrice * (1 + product.discount / 100) * (1 + discount / 100);
        return Number.isFinite(value) ? value : null;
    }
    function rowErrors(rows, products) {
        const errors = {};
        const checked = rows.filter(r => r.checked);
        checked.forEach(r => {
            if (!products.some(p => p.name === r.productName)) errors[r.id] = '请选择现有商品';
            else if (!friendName(r.friendName)) errors[r.id] = '请填写实际好友名称';
            else if (!validPrice(r.price)) errors[r.id] = '售价必须为正整数';
            else if (checked.filter(other => other.productName === r.productName).length > 1) errors[r.id] = '同商品只能选择一个候选';
        });
        return errors;
    }
    function importRows(rows, products, friends) {
        if (Object.keys(rowErrors(rows, products)).length) throw new Error('请修正核对表中的错误');
        const checked = rows.filter(r => r.checked);
        if (!checked.length) return false;
        let target = friends.find(f => f.source === 'game-capture');
        if (!target) {
            target = { source: 'game-capture', name: '游戏采集', discounts: {}, quotes: {} };
            friends.push(target);
        }
        target.name = '游戏采集';
        target.discounts = {};
        target.quotes = target.quotes || {};
        checked.forEach(r => Object.defineProperty(target.quotes, r.productName, {
            configurable: true, enumerable: true, writable: true,
            value: {
                price: r.price,
                friendName: friendName(r.friendName),
                capturedAt: r.capturedAt,
                observedLocalPrice: validPrice(r.observedLocalPrice) ? r.observedLocalPrice : null,
                ...(r.edited ? { manuallyModified: true } : {})
            }
        }));
        return true;
    }
    // Keep the source identity unique even with malformed/legacy duplicate stored sources.
    function normalizeFriends(friends) {
        let capture;
        return friends.filter(f => f && typeof f === 'object').filter(f => {
            f.discounts = f.discounts && typeof f.discounts === 'object' ? f.discounts : {};
            if (f.source !== 'game-capture') return true;
            if (capture) {
                Object.entries(f.quotes || {}).forEach(([k, v]) => {
                    if (!Object.prototype.hasOwnProperty.call(capture.quotes, k)) {
                        Object.defineProperty(capture.quotes, k, { value: v, writable: true, enumerable: true, configurable: true });
                    }
                });
                return false;
            }
            capture = f;
            f.name = '游戏采集';
            f.discounts = {};
            f.quotes = f.quotes && typeof f.quotes === 'object' ? f.quotes : {};
            return true;
        });
    }
    function addCandidate(rows, candidate) {
        const conflict = '同商品存在冲突候选';
        const group = candidate.productName || candidate.detectedName || '?';
        const same = rows.filter(r => (r.productName || r.detectedName || '?') === group);
        if (same.some(r => r.friendName === candidate.friendName && r.price === candidate.price)) return rows;
        if (same.length) {
            same.forEach(r => {
                r.checked = false;
                if (!r.reasons.includes(conflict)) r.reasons.push(conflict);
            });
            candidate.checked = false;
            candidate.reasons.push(conflict);
        }
        if (same.length >= TUNING.MAX_CANDIDATES_PER_PRODUCT || rows.length >= TUNING.MAX_ROWS) return rows;
        rows.push(candidate);
        return rows;
    }
    // Largest mean absolute difference over any single tile, so one changed digit is not averaged away.
    function grayDistance(a, b) {
        if (!a || !b || a.length !== b.length) return Infinity;
        const tilePixels = TUNING.TILE_SIZE * TUNING.TILE_SIZE;
        let max = 0;
        for (let offset = 0; offset < a.length; offset += tilePixels) {
            const end = Math.min(a.length, offset + tilePixels);
            let sum = 0;
            for (let i = offset; i < end; i++) sum += Math.abs(a[i] - b[i]);
            max = Math.max(max, sum / (end - offset));
        }
        return max;
    }
    class Engine {
        constructor({ products, onState = () => {}, onCandidate = () => {} }) {
            this.products = products;
            this.onState = onState;
            this.onCandidate = onCandidate;
            this.version = 0;
            this.sequence = 0;
            this.reset();
        }
        reset(reason = '等待商品详情') {
            this.version++;
            this.context = null;
            this.detectedName = '';
            this.page = null;
            this.previous = null;
            this.anchor = null;
            this.stable = 0;
            this.rounds = 0;
            this.evidence = null;
            this.done = false;
            this.transitionStartedAt = null;
            this.friendLoadingSince = null;
            this.observedAt = null;
            this.lastAttempt = -Infinity;
            this.onState(reason);
        }
        observe(gray, now = performance.now()) {
            this.sequence++;
            this.observedAt = now;
            if (this.friendLoadingSince !== null && now - this.friendLoadingSince > TUNING.FRIEND_LOAD_GRACE_MS) {
                this.version++;
                this.context = null;
                this.detectedName = '';
                this.friendLoadingSince = null;
                this.transitionStartedAt = null;
                this.evidence = null;
                this.rounds = 0;
                this.done = false;
                this.onState('好友列表加载超时，请重新打开商品详情');
            }
            // Each text region must be stable; a small price change must not be diluted by other fields.
            const near = grayDistance(gray, this.previous) <= TUNING.STABLE_DISTANCE &&
                grayDistance(gray, this.anchor) <= TUNING.STABLE_DISTANCE;
            if (!near) {
                // Invalidate every in-flight read immediately, before knowing the new page.
                this.version++;
                const leavingDetail = this.page === 'detail' && this.done;
                const inTransition = this.page === null && this.transitionStartedAt !== null &&
                    now - this.transitionStartedAt <= TUNING.TRANSITION_GRACE_MS;
                const loadingFriends = this.friendLoadingSince !== null;
                if (leavingDetail) this.transitionStartedAt = now;
                else if (!inTransition && !loadingFriends) {
                    this.context = null;
                    this.detectedName = '';
                    this.transitionStartedAt = null;
                }
                this.page = null;
                this.anchor = gray;
                this.stable = 1;
                this.rounds = 0;
                this.done = false;
                this.evidence = null;
                this.onState('等待画面稳定');
            } else this.stable++;
            this.previous = gray;
            return this.stable >= TUNING.STABLE_SAMPLES && !this.done && this.rounds < TUNING.MAX_ROUNDS &&
                this.sequence - this.lastAttempt >= TUNING.ATTEMPT_SPACING;
        }
        begin() {
            this.lastAttempt = this.sequence;
            this.rounds++;
            return { version: this.version, sequence: this.sequence, context: this.context };
        }
        accept(read, token, image = '') {
            if (token.version !== this.version) return false;
            if (read.page !== 'detail' && read.page !== 'friend') {
                this.reset('等待商品详情（未知页面，关联已清除；请检查区域校准）');
                return false;
            }
            this.page = read.page;
            this.transitionStartedAt = null;
            if (read.page === 'friend' && !read.friendName && !validPrice(read.price)) {
                // An empty list is not quote evidence. Retry it without consuming the detail
                // association; later row pixels changing are loading, not another product.
                if (this.friendLoadingSince === null) this.friendLoadingSince = this.observedAt ?? performance.now();
                this.evidence = null;
                this.rounds = 0;
                this.done = false;
                this.onState('好友列表为空或加载中，等待首位好友报价');
                return false;
            }
            this.friendLoadingSince = null;
            // Seeing another detail already ends the previous association, even before confirmation.
            if (read.page === 'detail') {
                this.context = null;
                this.detectedName = read.name || '';
            }
            const key = JSON.stringify([read.page, read.name, read.local, read.friendName, read.price, read.percent, read.top]);
            const repeated = this.evidence && this.evidence.key === key &&
                token.sequence - this.evidence.sequence >= TUNING.CONFIRM_SPACING;
            this.evidence = { key, sequence: token.sequence };
            if (!repeated && this.rounds < TUNING.MAX_ROUNDS) {
                this.onState(read.page === 'detail' ? '正在识别商品（等待第二帧确认）' : '正在识别最高报价（等待第二帧确认）');
                return false;
            }
            this.done = true;
            if (read.page === 'detail') {
                const match = root.OcrMerge.matchProduct(read.name, this.products());
                this.context = repeated && match.exactIndex >= 0
                    ? { name: this.products()[match.exactIndex].name, local: read.local, image }
                    : null;
                this.detectedName = read.name || '';
                this.onState(this.context ? '等待好友价格' : '商品关联待确认');
                return true;
            }
            const context = token.context;
            const reasons = [];
            if (!repeated) reasons.push('三轮识别不一致');
            if (!context) reasons.push('待选择商品：未紧接已确认的商品详情');
            if (!read.top) reasons.push('未确认列表位于顶部');
            if (!read.friendName) reasons.push('好友名称缺失');
            if (!validPrice(read.price)) reasons.push('售价无效或误读');
            const product = context && this.products().find(p => p.name === context.name);
            if (context && context.local && read.percent !== null && validPrice(read.price) &&
                Math.abs((read.price / context.local - 1) * 100 - read.percent) > TUNING.PERCENT_TOLERANCE) {
                reasons.push('售价与对比本地百分比不一致');
            }
            if (product && context.local &&
                Math.abs(product.basePrice * (1 + product.discount / 100) - context.local) > TUNING.LOCAL_PRICE_TOLERANCE) {
                reasons.push(`游戏本地价与计算器相差超过 ${TUNING.LOCAL_PRICE_TOLERANCE}`);
            }
            this.onCandidate({
                id: `${Date.now()}-${token.version}-${token.sequence}`,
                checked: !reasons.length,
                productName: context ? context.name : '',
                detectedName: this.detectedName || '',
                friendName: read.friendName || '',
                price: read.price,
                observedLocalPrice: context ? context.local : null,
                capturedAt: new Date().toISOString(),
                reasons,
                image,
                detailImage: context ? context.image : '',
                edited: false
            });
            this.context = null;
            this.onState(reasons.length ? '商品关联待确认 / 报价待核对' : '该商品已采集');
            return true;
        }
    }
    root.GameCaptureModel = {
        VERSION: '20261122.4',
        TUNING, defaultLayout, validLayout, validRect, absoluteRect, validPrice, parsePrice, friendName, parsePercent,
        friendPrice, rowErrors, importRows, normalizeFriends, addCandidate, grayDistance, Engine
    };
})(typeof self !== 'undefined' ? self : this);
