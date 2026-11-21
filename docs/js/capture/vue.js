// Vue owns editable review data only; controller and frozen frames stay outside reactivity.
(function (root) {
    'use strict';
    const M = root.GameCaptureModel, KEY = 'gameCaptureLayout:v1';

    // Calibration and export settings for the review dialog.
    const UI = Object.freeze({
        // Smallest normalized width/height a calibration region can be resized to.
        MIN_REGION_SIZE: 0.003,
        // Largest size of the cropped calibration preview, in pixels.
        PREVIEW_MAX_WIDTH: 800,
        PREVIEW_MAX_HEIGHT: 250,
        SNAPSHOT_JPEG_QUALITY: 0.85,
        // Delay before revoking the diagnostic download URL, so the browser can start the download.
        REVOKE_URL_DELAY_MS: 1000
    });

    let controller = null, frozen = null, drag = null;
    const empty = () => ({
        status: '模型尚未加载', ready: false, loading: false, running: false, paused: false, stopping: false,
        diagnosticsOnly: false, rows: [], diagnostic: { events: [] }, error: '', calibrating: false,
        page: 'detail', field: 'name', snapshot: '', preview: '', browserVersion: '', imported: false
    });
    function readLayout() {
        try {
            const l = JSON.parse(localStorage.getItem(KEY));
            return M.validLayout(l) ? l : M.defaultLayout();
        } catch (e) {
            return M.defaultLayout();
        }
    }
    root.GameCaptureVue = {
        data() {
            return { capture: empty(), captureLayout: readLayout() };
        },
        computed: {
            captureErrors() {
                return M.rowErrors(this.capture.rows, this.products);
            },
            canImportCapture() {
                const c = this.capture;
                return !c.running && !c.stopping && !c.loading && c.rows.some(r => r.checked) && !Object.keys(this.captureErrors).length;
            },
            captureCount() {
                return new Set(this.capture.rows.map(r => r.productName || r.id)).size;
            },
            capturePending() {
                return this.capture.rows.filter(r => r.reasons.length || !r.productName).length;
            },
            calibrationRect() {
                return this.capture.field === 'content' ? this.captureLayout.content : this.captureLayout[this.capture.page][this.capture.field];
            },
            calibrationFields() {
                return Object.keys(this.captureLayout[this.capture.page]);
            }
        },
        mounted() {
            this._capturePageHide = () => this.releaseCapture();
            window.addEventListener('pagehide', this._capturePageHide);
        },
        beforeUnmount() {
            window.removeEventListener('pagehide', this._capturePageHide);
            this.releaseCapture();
        },
        methods: {
            async openCaptureDialog() {
                this.resetImport();
                this.capture = empty();
                this.captureLayout = readLayout();
                this.openDialog('capture');
                await this.$nextTick();
                const state = this.capture;
                controller = root.GameCapture.createSession({
                    layout: JSON.parse(JSON.stringify(this.captureLayout)),
                    products: () => this.products,
                    onState: s => { if (this.capture === state) state.status = s; },
                    onCandidate: r => {
                        if (this.capture !== state) return;
                        M.addCandidate(state.rows, r);
                        state.imported = false;
                    },
                    onDiagnostic: d => { if (this.capture === state) state.diagnostic = d; },
                    onStopped: () => {
                        if (this.capture !== state) return;
                        state.running = false;
                        state.paused = false;
                        state.ready = false;
                    },
                    onVideo: v => { if (this.capture === state && this.$refs.captureVideo) this.$refs.captureVideo.appendChild(v); }
                });
                state.error = controller.supportError();
                if (state.error) {
                    state.status = '窗口无法读取';
                    return;
                }
                await this.prepareCapture();
            },
            async prepareCapture() {
                if (!controller || this.capture.loading) return;
                const support = controller.supportError();
                if (support) {
                    this.capture.error = support;
                    this.capture.status = '窗口无法读取';
                    return;
                }
                const session = controller, state = this.capture;
                state.loading = true;
                state.error = '';
                try {
                    await session.prepare();
                    if (controller === session && this.capture === state) state.ready = true;
                } catch (e) {
                    if (controller === session && !(e instanceof root.OcrRecognizer.CancelledError)) state.error = '模型加载失败：' + e.message;
                } finally {
                    if (controller === session) state.loading = false;
                }
            },
            startCapture() {
                if (!controller || (!this.capture.ready && !this.capture.diagnosticsOnly) || this.capture.running) return;
                const session = controller, state = this.capture;
                state.error = '';
                state.running = true;
                session.setDiagnosticsOnly(state.diagnosticsOnly);
                // No await before controller.start(): the browser picker requires this click.
                session.start().catch(e => {
                    if (controller !== session) return;
                    state.running = false;
                    state.error = e.name === 'NotAllowedError' ? '已取消或拒绝窗口共享，可以预热后重试。' : e.message;
                });
            },
            toggleCapture() {
                if (!controller) return;
                if (this.capture.paused) {
                    controller.resume();
                    this.capture.paused = false;
                } else {
                    controller.pause();
                    this.capture.paused = true;
                }
            },
            async stopCapture() {
                if (!controller) return;
                const state = this.capture;
                state.stopping = true;
                this.clearCalibration();
                try {
                    await controller.stop();
                } finally {
                    state.stopping = false;
                    state.ready = false;
                }
            },
            async releaseCapture() {
                const old = controller;
                controller = null;
                this.clearCalibration();
                this.capture.rows.forEach(r => {
                    r.image = '';
                    r.detailImage = '';
                });
                this.capture = empty();
                if (old) await old.dispose();
            },
            closeCapture() {
                if (this.capture.rows.length && !this.capture.imported && !confirm('存在未导入的采集结果，确定放弃并关闭？')) return false;
                this.releaseCapture();
                return true;
            },
            confirmCapture() {
                if (!this.canImportCapture) return;
                M.importRows(this.capture.rows, this.products, this.friends);
                this.saveFriends();
                this.capture.imported = true;
                this.closeDialog();
            },
            captureOld(row) {
                const f = this.friends.find(f => f.source === 'game-capture');
                return f ? M.friendPrice({ name: row.productName }, f) : null;
            },
            captureSuggestions(row) {
                return root.OcrMerge.matchProduct(row.detectedName, this.products).candidates;
            },
            captureLocal(row) {
                const p = this.products.find(p => p.name === row.productName);
                return p ? this.ownPrice(p) : null;
            },
            captureWarnings(row) {
                const reasons = [...row.reasons];
                const own = this.captureLocal(row);
                if (own !== null && row.observedLocalPrice && Math.abs(own - row.observedLocalPrice) > M.TUNING.LOCAL_PRICE_TOLERANCE &&
                    !reasons.some(s => s.includes('本地价'))) {
                    reasons.push('游戏与计算器本地价不同');
                }
                return reasons.join('；') || '重复确认通过';
            },
            editCaptureRow(row) {
                row.edited = true;
                this.capture.imported = false;
            },
            timeLabel(iso) {
                return iso ? new Date(iso).toLocaleString() : '—';
            },
            captureQuote(friend, product) {
                return friend.quotes && Object.prototype.hasOwnProperty.call(friend.quotes, product.name) ? friend.quotes[product.name] : null;
            },
            editCaptureQuote(friend, product, key, value) {
                if (key === 'price' && !M.validPrice(Number(value))) return;
                friend.quotes = friend.quotes || {};
                let q = this.captureQuote(friend, product);
                if (!q) {
                    if (key !== 'price') return;
                    q = { price: Number(value), friendName: '', capturedAt: null, observedLocalPrice: null };
                    Object.defineProperty(friend.quotes, product.name, { value: q, writable: true, enumerable: true, configurable: true });
                    q = friend.quotes[product.name];
                }
                q[key] = key === 'price' ? Number(value) : value;
                q.manuallyModified = true;
                this.saveFriends();
            },
            clearCaptureQuote(friend, product) {
                if (friend.quotes) delete friend.quotes[product.name];
                this.saveFriends();
            },
            exportCaptureDiagnostic() {
                const content = {
                    schema: 'game-capture-diagnostic:v1',
                    exportedAt: new Date().toISOString(),
                    browserVersion: this.capture.browserVersion || '待测试者填写',
                    userAgent: navigator.userAgent,
                    ...this.capture.diagnostic
                };
                const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'game-capture-diagnostic.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), UI.REVOKE_URL_DELAY_MS);
            },
            beginCalibration() {
                if (!controller) return;
                frozen = controller.freeze();
                if (!frozen) {
                    this.capture.error = '请先共享可读取的游戏窗口。';
                    return;
                }
                this.capture.paused = true;
                this.capture.calibrating = true;
                this.capture.snapshot = frozen.toDataURL('image/jpeg', UI.SNAPSHOT_JPEG_QUALITY);
                this.capture.field = 'name';
                this.updateCalibrationPreview();
            },
            clearCalibration() {
                if (frozen) {
                    frozen.width = frozen.height = 0;
                    frozen = null;
                }
                drag = null;
                this.capture.snapshot = '';
                this.capture.preview = '';
                this.capture.calibrating = false;
            },
            calibrationStyle(r) {
                const c = this.captureLayout.content;
                const b = r === c ? r : { x: c.x + r.x * c.w, y: c.y + r.y * c.h, w: r.w * c.w, h: r.h * c.h };
                return { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' };
            },
            beginRegionDrag(event, key, resize = false) {
                event.preventDefault();
                this.capture.field = key;
                const box = this.$refs.calibrationImage.getBoundingClientRect();
                drag = { x: event.clientX, y: event.clientY, rect: { ...this.calibrationRect }, box, resize };
                event.currentTarget.setPointerCapture(event.pointerId);
            },
            moveRegionDrag(event) {
                if (!drag) return;
                const content = this.capture.field === 'content' ? { w: 1, h: 1 } : this.captureLayout.content;
                const dx = (event.clientX - drag.x) / drag.box.width / content.w;
                const dy = (event.clientY - drag.y) / drag.box.height / content.h;
                const r = this.calibrationRect;
                if (drag.resize) {
                    r.w = Math.max(UI.MIN_REGION_SIZE, Math.min(1 - r.x, drag.rect.w + dx));
                    r.h = Math.max(UI.MIN_REGION_SIZE, Math.min(1 - r.y, drag.rect.h + dy));
                } else {
                    r.x = Math.max(0, Math.min(1 - r.w, drag.rect.x + dx));
                    r.y = Math.max(0, Math.min(1 - r.h, drag.rect.y + dy));
                }
                this.updateCalibrationPreview();
            },
            endRegionDrag() {
                drag = null;
            },
            captureRegionLabel(key) {
                return {
                    content: '有效内容范围',
                    title: '页面标识',
                    name: this.capture.page === 'detail' ? '商品名称' : '第一位好友名称',
                    localLabel: '今日售价标识',
                    local: '本地售价',
                    price: '第一位好友售价',
                    percent: '对比本地百分比（含箭头）',
                    top: '完整滚动条轨道'
                }[key] || key;
            },
            updateCalibrationPreview() {
                if (!frozen || !M.validRect(this.calibrationRect)) return;
                const c = this.captureLayout.content;
                const r = this.capture.field === 'content'
                    ? { x0: c.x * frozen.width, y0: c.y * frozen.height, x1: (c.x + c.w) * frozen.width, y1: (c.y + c.h) * frozen.height }
                    : M.absoluteRect(this.captureLayout, this.calibrationRect, frozen);
                const preview = document.createElement('canvas');
                preview.width = Math.min(UI.PREVIEW_MAX_WIDTH, Math.ceil(r.x1 - r.x0));
                preview.height = Math.min(UI.PREVIEW_MAX_HEIGHT, Math.ceil(r.y1 - r.y0));
                preview.getContext('2d').drawImage(frozen, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0, 0, preview.width, preview.height);
                this.capture.preview = preview.toDataURL('image/png');
                preview.width = preview.height = 0;
            },
            saveCalibration() {
                if (!M.validLayout(this.captureLayout)) {
                    this.capture.error = '区域必须位于画面内且宽高大于 0。';
                    return;
                }
                this.captureLayout.aspect = frozen.width / frozen.height;
                try {
                    localStorage.setItem(KEY, JSON.stringify(this.captureLayout));
                } catch (e) {
                    this.capture.error = '区域无法保存：' + e.message;
                    return;
                }
                controller.setLayout(JSON.parse(JSON.stringify(this.captureLayout)));
                this.clearCalibration();
                controller.resume();
                this.capture.paused = false;
                this.capture.error = '';
            }
        }
    };
})(window);
