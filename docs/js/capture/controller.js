(function (root) {
    'use strict';
    const VERSION = '20261122.4';
    const M = root.GameCaptureModel;
    const TILE = M.TUNING.TILE_SIZE;

    // Frame sampling, page-marker detection and diagnostic limits.
    const CAPTURE = Object.freeze({
        // Fingerprint tiles per region, laid out horizontally.
        FINGERPRINT_TILES: 4,
        // Minimum time between two processed samples.
        SAMPLE_INTERVAL_MS: 125,
        // Polling interval when requestVideoFrameCallback is unavailable.
        FALLBACK_POLL_MS: 100,
        // A sample or frame gap longer than this clears the product association.
        MAX_FRAME_GAP_MS: 3000,
        WATCHDOG_INTERVAL_MS: 500,
        // Relative aspect-ratio change that pauses capture until recalibration.
        ASPECT_TOLERANCE: 0.03,
        // A fingerprint whose every gray value is below this is treated as a black frame.
        BLACK_LEVEL: 8,
        MAX_EVENTS: 500,
        MAX_SAMPLING_WINDOWS: 60,
        // Scrollbar probe: the track is resampled to TOP_PROBE_WIDTH × TOP_PROBE_HEIGHT.
        TOP_PROBE_WIDTH: 8,
        TOP_PROBE_HEIGHT: 100,
        // Columns read from the middle of the probe, and how many must be dark for a dark row.
        TOP_PROBE_COLUMNS: [2, 6],
        TOP_DARK_PIXELS: 2,
        // Average RGB below this counts as a scrollbar-thumb pixel.
        TOP_DARK_LEVEL: 140,
        // Thumb height range, and how close to the track top it must start and end, in probe rows.
        TOP_THUMB_MIN_ROWS: 2,
        TOP_THUMB_MAX_ROWS: 22,
        TOP_THUMB_MAX_START: 10,
        TOP_THUMB_MAX_END: 25,
        // Review thumbnails: one row per field.
        THUMB_WIDTH: 360,
        THUMB_ROW_HEIGHT: 48,
        THUMB_PADDING_X: 5,
        THUMB_PADDING_Y: 4,
        THUMB_JPEG_QUALITY: 0.75
    });

    function canvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }
    function fields(layout, page, frame) {
        const kind = key => ['price', 'local'].includes(key) ? 'price' : key === 'percent' ? 'percent' : 'text';
        return Object.fromEntries(Object.entries(layout[page])
            .filter(([key]) => key !== 'top')
            .map(([key, r]) => [key, { rect: M.absoluteRect(layout, r, frame), kind: kind(key) }]));
    }
    function fingerprint(frame, layout, page = 'all') {
        const titles = [layout.detail.title, layout.friend.title];
        let regions;
        if (page === 'titles') regions = titles;
        else if (page === 'all') regions = [...Object.values(layout.detail), ...Object.values(layout.friend)];
        else regions = [...titles, ...Object.entries(layout[page]).filter(([key]) => key !== 'title').map(([, r]) => r)];
        const width = TILE * CAPTURE.FINGERPRINT_TILES;
        const c = canvas(width, TILE * regions.length);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        regions.forEach((r, i) => {
            const b = M.absoluteRect(layout, r, frame);
            ctx.drawImage(frame, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0, i * TILE, width, TILE);
        });
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        const gray = [];
        // Compare small text tiles separately so changing one digit is not hidden by blank space.
        for (let region = 0; region < regions.length; region++) {
            for (let tile = 0; tile < CAPTURE.FINGERPRINT_TILES; tile++) {
                for (let y = 0; y < TILE; y++) {
                    for (let x = 0; x < TILE; x++) {
                        const i = ((region * TILE + y) * width + tile * TILE + x) * 4;
                        gray.push(Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114));
                    }
                }
            }
        }
        c.width = c.height = 0;
        return gray;
    }
    function isTop(frame, layout) {
        const w = CAPTURE.TOP_PROBE_WIDTH, h = CAPTURE.TOP_PROBE_HEIGHT;
        const [fromColumn, toColumn] = CAPTURE.TOP_PROBE_COLUMNS;
        const b = M.absoluteRect(layout, layout.friend.top, frame);
        const c = canvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(frame, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const dark = [];
        for (let y = 0; y < h; y++) {
            let n = 0;
            for (let x = fromColumn; x < toColumn; x++) {
                const i = (y * w + x) * 4;
                if ((d[i] + d[i + 1] + d[i + 2]) / 3 < CAPTURE.TOP_DARK_LEVEL) n++;
            }
            if (n >= CAPTURE.TOP_DARK_PIXELS) dark.push(y);
        }
        c.width = c.height = 0;
        return dark.length >= CAPTURE.TOP_THUMB_MIN_ROWS && dark.length <= CAPTURE.TOP_THUMB_MAX_ROWS &&
            dark[0] <= CAPTURE.TOP_THUMB_MAX_START && dark[dark.length - 1] < CAPTURE.TOP_THUMB_MAX_END;
    }
    function thumbnails(frame, layout, page) {
        const keys = page === 'friend' ? ['title', 'name', 'price', 'percent'] : ['title', 'name', 'local'];
        const rowHeight = CAPTURE.THUMB_ROW_HEIGHT, padX = CAPTURE.THUMB_PADDING_X, padY = CAPTURE.THUMB_PADDING_Y;
        const out = canvas(CAPTURE.THUMB_WIDTH, keys.length * rowHeight);
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#eee';
        ctx.fillRect(0, 0, out.width, out.height);
        keys.forEach((k, i) => {
            const b = M.absoluteRect(layout, layout[page][k], frame);
            const w = b.x1 - b.x0, h = b.y1 - b.y0;
            const scale = Math.min((CAPTURE.THUMB_WIDTH - 2 * padX) / w, (rowHeight - 2 * padY) / h);
            ctx.drawImage(frame, b.x0, b.y0, w, h, padX, i * rowHeight + padY, w * scale, h * scale);
        });
        const url = out.toDataURL('image/jpeg', CAPTURE.THUMB_JPEG_QUALITY);
        out.width = out.height = 0;
        return url;
    }
    async function readFrame(ocr, frame, layout, context) {
        const friendFields = fields(layout, 'friend', frame);
        const markers = await ocr.recognizeRegions(frame, {
            friendTitle: friendFields.title
        });
        const classify = text => {
            const title = text.replace(/\s/g, '');
            return title.includes('好友价格') ? 'friend'
                : title.includes('购买物资') || title.includes('出售物资') ? 'detail' : 'unknown';
        };
        let page = classify(markers.friendTitle.text);
        // The two calibrated title regions usually overlap. Read the second only when
        // the first cannot identify either page; each OCR attempt still reads its own title.
        if (page === 'unknown') {
            Object.assign(markers, await ocr.recognizeRegions(frame, {
                detailTitle: fields(layout, 'detail', frame).title
            }));
            page = classify(markers.detailTitle.text);
        }
        if (page === 'unknown') return { page, raw: markers };
        const regions = page === 'friend' ? friendFields : fields(layout, page, frame);
        delete regions.title;
        const raw = { ...markers, ...await ocr.recognizeRegions(frame, regions) };
        if (page === 'detail') {
            const hasLocalLabel = raw.localLabel.text.replace(/\s/g, '').includes('今日售价');
            return {
                page,
                name: root.OcrParse.cleanName(raw.name.text),
                local: hasLocalLabel ? M.parsePrice(raw.local.text) : null,
                raw
            };
        }
        // Sign triangle may be just outside the number region: missing percent remains optional.
        const b = M.absoluteRect(layout, layout.friend.percent, frame);
        const left = Math.max(0, Math.floor(b.x0 - (b.y1 - b.y0)));
        const pixels = frame.getContext('2d', { willReadFrequently: true }).getImageData(
            left, Math.floor(b.y0), Math.max(1, Math.floor(b.x1 - left)), Math.max(1, Math.floor(b.y1 - b.y0))).data;
        const sign = root.OcrPair.colorSign(pixels);
        return {
            page,
            friendName: M.friendName(raw.name.text),
            price: M.parsePrice(raw.price.text),
            percent: M.parsePercent(raw.percent.text, sign),
            top: layout.noScroll ? !!context : isTop(frame, layout),
            raw
        };
    }
    function createSession(options = {}) {
        const { onState = () => {}, onCandidate = () => {}, onDiagnostic = () => {}, onVideo = () => {}, onStopped = () => {} } = options;
        let layout = options.layout || M.defaultLayout();
        let ocr = null, stream = null, video = null, frameId = null, timer = null, watchdog = null;
        let version = 0, paused = false, active = false, disposed = false, preparing = null, busy = false, pending = null;
        let lastSample = 0, lastMedia = -1, lastArrival = 0, aspect = null, stalled = false;
        let runStarted = 0, runSamples = 0, stopping = null;
        let fingerprintPage = null, lastTitles = null, titleAnchor = null;
        const diagnostics = {
            codeVersions: { controller: VERSION, model: M.VERSION || 'unversioned' },
            events: [], samplingWindows: [], samples: 0, frames: 0,
            longestGapMs: 0, lastIntervalMs: 0, lastFrameIntervalMs: 0, longestFrameGapMs: 0,
            firstValidFrame: null, lastValidFrame: null, lastRecognition: null, modelMs: null,
            width: 0, height: 0, hidden: document.hidden, track: '未共享', actualSamplesPerSecond: 0
        };
        const publish = () => onDiagnostic({
            ...diagnostics,
            samplingWindows: diagnostics.samplingWindows.map(w => ({ ...w })),
            events: diagnostics.events.slice()
        });
        const emit = (type, data = {}) => {
            diagnostics.events.push({ at: new Date().toISOString(), type, ...data });
            if (diagnostics.events.length > CAPTURE.MAX_EVENTS) diagnostics.events.shift();
            publish();
        };
        let engine;
        engine = new M.Engine({
            products: options.products || (() => []),
            onState: s => {
                diagnostics.currentProduct = engine?.context?.name || '';
                emit('state', { state: s, currentProduct: diagnostics.currentProduct });
                onState(s);
            },
            onCandidate
        });
        const visibility = () => {
            diagnostics.hidden = document.hidden;
            emit('visibility', { hidden: document.hidden });
        };
        document.addEventListener('visibilitychange', visibility);
        const release = f => { if (f) f.width = f.height = 0; };
        const clearPending = () => {
            if (pending) release(pending.frame);
            pending = null;
        };
        function invalidate(reason) {
            version++;
            clearPending();
            fingerprintPage = null;
            lastTitles = null;
            titleAnchor = null;
            engine.reset(reason);
        }
        function prepare() {
            if (disposed) return Promise.reject(new Error('会话已关闭'));
            if (!ocr) {
                const create = options.createOcr || root.OcrRecognizer.createRegionSession;
                ocr = create({ onProgress: p => { if (!disposed) onState(p.label); } });
            }
            if (!preparing) {
                const began = performance.now(), target = ocr;
                onState('模型加载中');
                preparing = ocr.prepare().then(() => {
                    if (disposed || target !== ocr) throw new root.OcrRecognizer.CancelledError();
                    diagnostics.modelMs = performance.now() - began;
                    emit('model-ready');
                    onState('等待商品详情（模型已就绪）');
                    return true;
                }).catch(e => {
                    if (target === ocr) {
                        preparing = null;
                        if (!disposed) {
                            onState('模型加载失败：' + e.message);
                            emit('model-error', { message: e.message });
                        }
                    }
                    throw e;
                });
            }
            return preparing;
        }
        function supportError() {
            if (M.VERSION !== VERSION) return '采集组件版本不一致，请刷新页面后重试（商品识别脚本仍是旧版本）';
            if (!root.isSecureContext) return '窗口采集需要 HTTPS 或 localhost 安全上下文';
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return '此浏览器不支持窗口共享，请使用 Windows Edge / Chrome';
            return '';
        }
        function schedule() {
            if (!active || !video) return;
            if (video.requestVideoFrameCallback) {
                frameId = video.requestVideoFrameCallback((now, meta) => {
                    receive(now, meta.mediaTime);
                    schedule();
                });
            } else {
                timer = setTimeout(() => {
                    const quality = video.getVideoPlaybackQuality?.();
                    receive(performance.now(), quality?.totalVideoFrames > 0 ? quality.totalVideoFrames : video.currentTime);
                    schedule();
                }, CAPTURE.FALLBACK_POLL_MS);
            }
        }
        function recordSample(frame, now, gap) {
            stalled = false;
            diagnostics.width = frame.width;
            diagnostics.height = frame.height;
            diagnostics.samples++;
            diagnostics.lastValidFrame = new Date().toISOString();
            diagnostics.firstValidFrame = diagnostics.firstValidFrame || diagnostics.lastValidFrame;
            const minute = diagnostics.lastValidFrame.slice(0, 16);
            let bucket = diagnostics.samplingWindows.at(-1);
            if (!bucket || bucket.minute !== minute) {
                bucket = { minute, samples: 0, hiddenSamples: 0, first: diagnostics.lastValidFrame, last: diagnostics.lastValidFrame };
                diagnostics.samplingWindows.push(bucket);
                if (diagnostics.samplingWindows.length > CAPTURE.MAX_SAMPLING_WINDOWS) diagnostics.samplingWindows.shift();
            }
            bucket.samples++;
            if (document.hidden) bucket.hiddenSamples++;
            bucket.last = diagnostics.lastValidFrame;
            diagnostics.actualSamplesPerSecond = (diagnostics.samples - runSamples) / Math.max(.001, (now - runStarted) / 1000);
            emit('sample', { intervalMs: gap });
        }
        function receive(now, mediaTime) {
            if (!active || !video) return;
            if (mediaTime === lastMedia) return;
            diagnostics.lastFrameIntervalMs = lastArrival ? Math.max(0, now - lastArrival) : 0;
            diagnostics.longestFrameGapMs = Math.max(diagnostics.longestFrameGapMs, diagnostics.lastFrameIntervalMs);
            lastMedia = mediaTime;
            diagnostics.frames++;
            lastArrival = now;
            if (now - lastSample < CAPTURE.SAMPLE_INTERVAL_MS) return;
            const gap = lastSample ? now - lastSample : 0;
            diagnostics.lastIntervalMs = gap;
            diagnostics.longestGapMs = Math.max(diagnostics.longestGapMs, gap);
            if (gap > CAPTURE.MAX_FRAME_GAP_MS) invalidate(`等待商品详情（帧间断超过 ${CAPTURE.MAX_FRAME_GAP_MS / 1000} 秒）`);
            lastSample = now;
            if (paused) return;
            const track = stream && stream.getVideoTracks()[0];
            if (!track || track.muted || track.readyState === 'ended' || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
                invalidate('采集暂停：窗口无法读取');
                emit('invalid-frame');
                return;
            }
            const ratio = video.videoWidth / video.videoHeight;
            if (aspect && Math.abs(ratio / aspect - 1) > CAPTURE.ASPECT_TOLERANCE) {
                paused = true;
                invalidate('画面宽高比变化，请重新校准');
                emit('aspect-change', { ratio });
                return;
            }
            aspect = aspect || ratio;
            const f = canvas(video.videoWidth, video.videoHeight);
            const ctx = f.getContext('2d', { willReadFrequently: true });
            try {
                ctx.drawImage(video, 0, 0);
            } catch (e) {
                release(f);
                invalidate('窗口无法读取');
                emit('read-error', { message: e.message });
                return;
            }
            const titles = fingerprint(f, layout, 'titles');
            if (M.grayDistance(titles, lastTitles) > M.TUNING.STABLE_DISTANCE || M.grayDistance(titles, titleAnchor) > M.TUNING.STABLE_DISTANCE) {
                fingerprintPage = null;
                titleAnchor = titles;
            }
            lastTitles = titles;
            const gray = fingerprint(f, layout, fingerprintPage || 'titles');
            if (gray.every(v => v < CAPTURE.BLACK_LEVEL)) {
                release(f);
                invalidate('采集暂停：黑屏，等待可读画面');
                emit('black-frame');
                return;
            }
            recordSample(f, now, gap);
            if (engine.observe(gray, now) && !options.diagnosticsOnly) {
                clearPending();
                pending = { frame: f, engineVersion: engine.version, version, sequence: engine.sequence };
                drain();
            } else release(f);
        }
        async function drain() {
            if (busy || !pending || !active || paused) return;
            if (engine.done || engine.rounds >= M.TUNING.MAX_ROUNDS) {
                clearPending();
                return;
            }
            busy = true;
            const task = pending;
            pending = null;
            const began = performance.now();
            if (task.engineVersion !== engine.version) {
                release(task.frame);
                busy = false;
                return;
            }
            task.token = engine.begin();
            task.token.sequence = task.sequence;
            try {
                const read = await (options.readFrame || readFrame)(ocr, task.frame, layout, task.token.context);
                if (task.version !== version || !active || paused || disposed || task.token.version !== engine.version) return;
                diagnostics.lastRecognition = new Date().toISOString();
                const known = read.page === 'friend' || read.page === 'detail';
                if (known && fingerprintPage !== read.page) {
                    // Once classified, recheck stability against this page's text only. Never compare
                    // the other page's regions: those coordinates can contain animated avatars.
                    fingerprintPage = read.page;
                    engine.previous = engine.anchor = fingerprint(task.frame, layout, read.page);
                    engine.stable = 1;
                    clearPending();
                }
                const accepted = engine.accept(read, task.token, known ? thumbnails(task.frame, layout, read.page) : '');
                emit('recognition', {
                    durationMs: performance.now() - began, page: read.page, raw: read.raw || {}, accepted,
                    productBefore: task.token.context?.name || '', productAfter: engine.context?.name || '',
                    detectedName: engine.detectedName
                });
            } catch (e) {
                if (task.version === version && active) {
                    invalidate('窗口无法读取 / 识别失败：' + e.message);
                    emit('ocr-error', { message: e.message });
                }
            } finally {
                release(task.frame);
                busy = false;
                if (pending) drain();
            }
        }
        function watchFrames() {
            if (!active || paused) return;
            const gap = performance.now() - lastArrival;
            if (gap <= CAPTURE.MAX_FRAME_GAP_MS) return;
            diagnostics.longestGapMs = Math.max(diagnostics.longestGapMs, gap);
            diagnostics.longestFrameGapMs = Math.max(diagnostics.longestFrameGapMs, gap);
            if (!stalled) {
                stalled = true;
                invalidate('等待新视频帧（关联已清除）');
                emit('frame-gap', { gapMs: gap });
            } else publish();
        }
        // getDisplayMedia is called before any await, in the user click's activation scope.
        function start() {
            const error = supportError();
            if (error) {
                onState(error);
                emit('unsupported', { message: error });
                return Promise.reject(new Error(error));
            }
            if (active || disposed) return Promise.reject(new Error(disposed ? '会话已关闭' : '采集已经开始'));
            invalidate();
            const id = version;
            let request;
            try {
                const getDisplayMedia = options.getDisplayMedia || navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
                request = getDisplayMedia({ video: true, audio: false });
            } catch (e) {
                onState('窗口无法读取：' + e.message);
                emit('share-error', { name: e.name, message: e.message });
                return Promise.reject(e);
            }
            return request.then(async result => {
                if (id !== version || disposed) {
                    result.getTracks().forEach(t => t.stop());
                    return;
                }
                stream = result;
                video = (options.createVideo || (() => document.createElement('video')))();
                video.muted = true;
                video.autoplay = true;
                video.playsInline = true;
                video.srcObject = stream;
                const track = stream.getVideoTracks()[0];
                if (!track) throw new Error('共享没有视频轨道');
                track.onended = () => {
                    emit('share-ended');
                    stop('共享已结束，请核对结果');
                };
                track.onmute = () => {
                    diagnostics.track = 'muted';
                    invalidate('采集暂停：视频轨道静音');
                    emit('track-muted');
                };
                track.onunmute = () => {
                    diagnostics.track = 'live';
                    invalidate('等待商品详情');
                    emit('track-unmuted');
                };
                await video.play();
                if (id !== version || disposed) {
                    await stop();
                    return;
                }
                active = true;
                paused = false;
                aspect = layout.aspect || null;
                lastSample = 0;
                lastMedia = -1;
                runStarted = performance.now();
                runSamples = diagnostics.samples;
                lastArrival = runStarted;
                diagnostics.frameSource = video.requestVideoFrameCallback ? 'requestVideoFrameCallback' : 'timer / playback quality or media time';
                const settings = track.getSettings ? track.getSettings() : {};
                diagnostics.track = 'live';
                emit('start', { settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate, displaySurface: settings.displaySurface } });
                onVideo(video);
                onState('等待商品详情');
                schedule();
                watchdog = setInterval(watchFrames, CAPTURE.WATCHDOG_INTERVAL_MS);
            }).catch(async e => {
                if (id === version) {
                    await stop('窗口无法读取：' + e.message);
                    emit('share-error', { name: e.name, message: e.message });
                }
                throw e;
            });
        }
        function pause() {
            if (!active) return;
            paused = true;
            invalidate('采集暂停');
            emit('pause');
        }
        function resume() {
            if (!active) return;
            paused = false;
            lastSample = 0;
            invalidate('等待商品详情');
            emit('resume');
        }
        function stop(label = '采集已停止，请核对结果') {
            if (stopping) return stopping;
            active = false;
            paused = false;
            invalidate(label);
            if (video && frameId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
            frameId = null;
            clearTimeout(timer);
            timer = null;
            clearInterval(watchdog);
            watchdog = null;
            if (stream) {
                stream.getTracks().forEach(t => {
                    t.onended = t.onmute = t.onunmute = null;
                    t.stop();
                });
                stream = null;
            }
            if (video) {
                video.pause();
                video.srcObject = null;
                video.remove();
                video = null;
            }
            const old = ocr;
            ocr = null;
            preparing = null;
            diagnostics.track = 'ended';
            emit('stop');
            onStopped();
            stopping = (old ? Promise.resolve(old.dispose()) : Promise.resolve()).finally(() => { stopping = null; });
            return stopping;
        }
        async function dispose() {
            if (disposed) return;
            disposed = true;
            document.removeEventListener('visibilitychange', visibility);
            await stop();
            diagnostics.events = [];
        }
        function freeze() {
            if (!video || video.readyState < 2) return null;
            const c = canvas(video.videoWidth, video.videoHeight);
            c.getContext('2d').drawImage(video, 0, 0);
            pause();
            return c;
        }
        function setLayout(next) {
            if (!M.validLayout(next)) throw new Error('区域无效');
            layout = next;
            aspect = next.aspect;
            invalidate('区域已调整，等待商品详情');
            emit('layout-change');
        }
        function setDiagnosticsOnly(value) {
            options.diagnosticsOnly = !!value;
            invalidate('等待商品详情');
            emit('diagnostics-mode', { enabled: !!value });
        }
        return {
            prepare, start, pause, resume, stop, dispose, freeze, setLayout, setDiagnosticsOnly, supportError,
            diagnostic: () => JSON.parse(JSON.stringify(diagnostics)),
            // Injectable frame/video/OCR dependencies exercise this same production scheduler in tests.
            get active() { return active; },
            get paused() { return paused; },
            get queueSize() { return pending ? 1 : 0; }
        };
    }
    root.GameCapture = { VERSION, CAPTURE, createSession, readFrame, fingerprint, isTop, fields, thumbnails };
})(typeof self !== 'undefined' ? self : this);
