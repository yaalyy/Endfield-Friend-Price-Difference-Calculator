(async()=>{
    const log=[],ok=(v,m)=>{log.push((v?'ok   ':'FAIL ')+m);document.getElementById('out').textContent=log.join('\n');},M=GameCaptureModel;
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    try{
        ok(M.friendName(' 绘梦逐空＃3847\n')==='绘梦逐空#3847','friend suffix and valid punctuation preserved');
        for(const v of ['','0','-1','4O57','4657.2','4657 4591'])ok(M.parsePrice(v)===null,'reject ambiguous/zero price '+v);
        ok(M.parsePrice('４６５７')===4657,'integer parsing');
        ok(M.parsePercent('7.2%',1)===7.2&&M.parsePercent('7.2%',-1)===-7.2&&M.parsePercent('7.2%')===null,'percent needs sign or color');
        const products=[{name:'商品A',basePrice:2000,discount:100},{name:'商品B',basePrice:2000,discount:0}],friends=[{name:'游戏采集',discounts:{}}];
        const row={id:'one',checked:true,productName:'商品A',friendName:'绘梦逐空#3847',price:4657,observedLocalPrice:4346,capturedAt:'2026-11-20T01:18:46.000Z'};
        M.importRows([row],products,friends);const capture=friends[1];
        ok(friends.length===2&&capture.source==='game-capture'&&friends[0].source===undefined,'ordinary same-name friend retained');
        ok(M.friendPrice(products[0],capture)===4657,'exact integer quote saved');products[0].discount=50;
        ok(M.friendPrice(products[0],capture)===4657&&M.friendPrice(products[1],capture)===null,'absolute quote independent of local discount; missing quote null');
        ok(M.friendPrice(products[1],friends[0])===2000,'ordinary empty discount retains zero percent');
        M.importRows([{...row,price:4601}],products,friends);
        ok(friends.length===2&&capture.quotes['商品A'].price===4601,'recapture updates one source');
        ok(Object.keys(M.rowErrors([{...row},{...row,id:'two'}],products)).length===2,'duplicate selected product blocked');
        const clone=JSON.parse(JSON.stringify(friends));ok(clone[1].quotes['商品A'].price===4601,'quotes survive JSON roundtrip');
        ok(M.normalizeFriends([capture,{source:'game-capture',quotes:{商品B:{price:2300}}}]).length===1&&capture.quotes['商品B'].price===2300,'duplicate source normalized');
        const rows=[];M.addCandidate(rows,{...row,reasons:[]});M.addCandidate(rows,{...row,id:'same',reasons:[]});
        ok(rows.length===1,'same name/price merged');M.addCandidate(rows,{...row,id:'two',price:4000,reasons:[]});M.addCandidate(rows,{...row,id:'three',price:9000,reasons:[]});
        ok(rows.length===2&&rows.every(r=>!r.checked),'conflicts bounded to two; higher price not preferred');
        const results=[],states=[];let engine=new M.Engine({products:()=>products,onCandidate:r=>results.push(r),onState:s=>states.push(s)});
        let shade=10;
        function sample(read){if(engine.observe([shade,shade,shade]))engine.accept(read,engine.begin(),'crop');}
        function confirm(read){for(let i=0;i<5;i++)sample(read);}
        const detail=name=>({page:'detail',name,local:3000}),friend=(price=3300)=>({page:'friend',friendName:'好友#1234',price,percent:10,top:true});
        confirm(detail('商品A'));shade=50;confirm(friend());
        ok(results[0].productName==='商品A'&&results[0].checked,'detail A -> friend A confirmed from two independent stable frames');
        shade=90;confirm({...detail('商品B'),local:2000});shade=130;confirm({...friend(2200)});
        ok(results[1].productName==='商品B'&&results[1].checked,'detail B -> friend B never uses A context');
        engine.reset();shade=160;confirm(friend());ok(results.at(-1).productName===''&&!results.at(-1).checked,'starting on friend page requires product selection');
        engine.reset();shade=20;confirm(detail('商品AA'));shade=60;confirm(friend());ok(!results.at(-1).checked,'similar product never auto-associated');
        engine.reset();shade=100;confirm(detail('商品A'));shade=140;confirm({...friend(),top:false});ok(!results.at(-1).checked&&results.at(-1).reasons.some(r=>r.includes('顶部')),'scrolled list pending review');
        engine.reset();shade=10;confirm(detail('商品A'));shade=50;confirm({...friend(),percent:25});ok(!results.at(-1).checked,'percent mismatch pending review');
        engine.reset();shade=90;confirm(detail('商品A'));shade=130;confirm({...friend(),percent:null});ok(results.at(-1).checked,'missing optional percent allowed');
        engine.reset();shade=10;confirm(detail('商品A'));shade=50;for(let i=0;i<3;i++)engine.observe([shade,shade,shade]);const token=engine.begin();engine.observe([200,200,200]);const count=results.length;
        ok(!engine.accept(friend(),token)&&results.length===count,'late OCR after page change discarded');
        engine.reset();ok(!engine.accept(friend(),token),'old session/context token discarded');
        engine.reset();shade=10;confirm(detail('商品A'));shade=50;engine.observe([shade,shade,shade]);shade=90;confirm(friend());ok(!results.at(-1).checked,'two transitions before detail reconfirmation cannot reuse old product');
        engine.reset();shade=10;confirm(detail('商品A'));shade=50;confirm({...friend(),friendName:''});ok(!results.at(-1).checked,'missing required friend name never auto passes');
        for(const reason of ['pause','gap','layout','ended']){shade=10;confirm(detail('商品A'));engine.reset(reason);shade=80;confirm(friend());ok(!results.at(-1).checked,reason+' clears association');engine.reset();}
        engine.reset();shade=20;for(let i=0;i<7;i++)sample({...friend(),price:3300+i});ok(!results.at(-1).checked&&results.at(-1).reasons.includes('三轮识别不一致'),'three inconsistent rounds become pending');

        // Mock a native Canvas as the video source: drawImage still runs against real browser pixels.
        let callback,media=0,clock=performance.now(),reads=0,disposed=0,trackStops=0,readResolve;
        const source=document.createElement('canvas');source.width=1379;source.height=792;
        Object.assign(source,{videoWidth:1379,videoHeight:792,readyState:4,muted:false,play:()=>Promise.resolve(),pause:()=>{},requestVideoFrameCallback:cb=>{callback=cb;return 1;},cancelVideoFrameCallback:()=>{callback=null;}});
        const paint=v=>{const c=source.getContext('2d');c.fillStyle=`rgb(${v},${v},${v})`;c.fillRect(0,0,source.width,source.height);};paint(70);
        const track={readyState:'live',muted:false,stop(){trackStops++;},getSettings:()=>({width:1379,height:792})};const stream={getVideoTracks:()=>[track],getTracks:()=>[track]};
        const diag=[],observed=[];
        const session=GameCapture.createSession({layout:M.defaultLayout(),products:()=>products,getDisplayMedia:()=>Promise.resolve(stream),createVideo:()=>source,
            createOcr:()=>({prepare:()=>Promise.resolve(),dispose:async()=>{disposed++;}}),readFrame:()=>{reads++;return new Promise(r=>{readResolve=r;});},onCandidate:r=>observed.push(r),onDiagnostic:d=>diag.push(d)});
        await session.prepare();await session.start();
        async function tick(ms=510){clock+=ms;media+=ms/1000;const cb=callback;callback=null;if(cb)cb(clock,{mediaTime:media});await wait(0);}
        for(let i=0;i<15;i++)await tick();ok(reads===1&&session.queueSize<=1,'slow OCR keeps one running and at most latest pending frame');
        session.pause();readResolve(friend());await wait(0);ok(observed.length===0,'pause rejects in-flight result');
        session.resume();paint(110);for(let i=0;i<3;i++)await tick();ok(reads===2,'resume restarts from detail wait');
        paint(190);await tick();readResolve(friend());await wait(0);ok(observed.length===0,'page changes reject late OCR in production scheduler');
        const samples=diag.at(-1).samples;await tick(4001);ok(diag.at(-1).longestGapMs>=4001,'actual frame gap diagnostic measured');
        ok(diag.at(-1).samples>samples,'static pixels with new video timestamps remain valid');
        const latestSamples=diag.at(-1).samples;const duplicate=callback;callback=null;duplicate(clock+510,{mediaTime:media});await wait(0);ok(diag.at(-1).samples===latestSamples,'old media timestamp is not a new frame');
        paint(0);await tick();ok(diag.at(-1).events.at(-1).type==='black-frame','black frame clears association instead of OCR');paint(80);
        track.onmute();ok(diag.at(-1).events.some(e=>e.type==='track-muted'),'track mute diagnostic');track.muted=false;track.onunmute();
        track.onended();await wait(0);ok(!session.active&&trackStops===1&&disposed===1,'browser sharing ended stops tracks and OCR');
        await session.stop();await session.dispose();await session.dispose();ok(trackStops===1&&callback===null,'stop/dispose idempotent without callback leak');
        ok(diag.at(-1).events.length<=500&&!JSON.stringify(diag.at(-1)).includes('data:image'),'bounded diagnostic contains no screenshots');
        let happyReads=0,fulfill;
        const happyResults=[],track2={...track,stop:()=>{}};const stream2={getVideoTracks:()=>[track2],getTracks:()=>[track2]};
        const happy=GameCapture.createSession({products:()=>products,getDisplayMedia:()=>Promise.resolve(stream2),createVideo:()=>source,createOcr:()=>({prepare:async()=>{},dispose:async()=>{}}),readFrame:()=>{happyReads++;return new Promise(r=>{fulfill=r;});},onCandidate:r=>happyResults.push(r)});
        await happy.prepare();await happy.start();paint(65);
        for(let i=0;i<9;i++)await tick();fulfill(detail('商品A'));await wait(0);
        for(let i=0;i<3;i++)await tick();fulfill(detail('商品A'));await wait(0);
        ok(happyReads===2&&happy.queueSize===0,'confirmation discards a queued third OCR of unchanged detail');
        paint(175);for(let i=0;i<3;i++)await tick();fulfill(friend());await wait(0);for(let i=0;i<2;i++)await tick();fulfill(friend());await wait(0);
        ok(happyResults.length===1&&happyResults[0].productName==='商品A'&&happyResults[0].checked,'production scheduler carries confirmed detail into one correct friend candidate');
        const completedReads=happyReads;for(let i=0;i<5;i++)await tick();ok(happyReads===completedReads,'confirmed unchanged friend page does not repeatedly OCR');
        source.videoWidth=1000;await tick();ok(happy.paused,'aspect ratio change pauses automatic recognition');source.videoWidth=1379;await happy.stop();await happy.dispose();
        let diagnosticReads=0;const only=GameCapture.createSession({getDisplayMedia:()=>Promise.resolve(stream2),createVideo:()=>source,readFrame:async()=>{diagnosticReads++;return friend();}});only.setDiagnosticsOnly(true);await only.start();for(let i=0;i<6;i++)await tick();ok(only.diagnostic().samples>0&&diagnosticReads===0,'diagnostics-only mode captures frames without model or OCR');await only.dispose();
        source.requestVideoFrameCallback=undefined;let decoded=1;source.getVideoPlaybackQuality=()=>({totalVideoFrames:decoded});
        const fallback=GameCapture.createSession({getDisplayMedia:()=>Promise.resolve(stream2),createVideo:()=>source,diagnosticsOnly:true});await fallback.start();await wait(160);const firstFallback=fallback.diagnostic().samples;await wait(550);ok(fallback.diagnostic().samples===firstFallback,'fallback skips unchanged decoded frame count');decoded++;await wait(160);ok(fallback.diagnostic().samples>firstFallback,'fallback timer samples a new decoded frame');await fallback.stop();const fallbackStopped=fallback.diagnostic().samples;decoded++;await wait(160);ok(fallback.diagnostic().samples===fallbackStopped,'fallback timer stops without residual sampling');await fallback.dispose();
        const reject=GameCapture.createSession({getDisplayMedia:()=>Promise.reject(new DOMException('denied','NotAllowedError'))});
        try{await reject.start();ok(false,'sharing refusal rejects');}catch(e){ok(!reject.active,'sharing refusal safely stops');}await reject.dispose();
        const bad=GameCapture.createSession({createOcr:()=>({prepare:()=>Promise.reject(new Error('model fail')),dispose:()=>Promise.resolve()})});try{await bad.prepare();ok(false,'model failure');}catch(e){ok(e.message==='model fail','model load failure exposed');}await bad.dispose();
        const originalDisplay=navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia=undefined;
        const unsupported=GameCapture.createSession();ok(unsupported.supportError().includes('不支持'),'unsupported sharing API has explicit reason');await unsupported.dispose();navigator.mediaDevices.getDisplayMedia=originalDisplay;
        let latePrepareResolve;
        const latePrepare=GameCapture.createSession({createOcr:()=>({prepare:()=>new Promise(r=>{latePrepareResolve=r;}),dispose:()=>Promise.resolve()})});
        const preparation=latePrepare.prepare().then(()=>false,()=>true);await latePrepare.stop();latePrepareResolve();ok(await preparation,'stopped preparation cannot report model ready');await latePrepare.dispose();

        // Controller edge paths, each on its own scripted canvas video source.
        function rig(extra={}){
            const r={callback:null,clock:performance.now(),media:0,stops:0,diag:[],states:[]};
            const src=document.createElement('canvas');src.width=1379;src.height=792;r.source=src;
            Object.assign(src,{videoWidth:1379,videoHeight:792,readyState:4,muted:false,play:()=>Promise.resolve(),pause:()=>{},requestVideoFrameCallback:cb=>{r.callback=cb;return 1;},cancelVideoFrameCallback:()=>{r.callback=null;}});
            r.paint=v=>{const c=src.getContext('2d');c.fillStyle=`rgb(${v},${v},${v})`;c.fillRect(0,0,src.width,src.height);};r.paint(70);
            r.track={readyState:'live',muted:false,stop(){r.stops++;},getSettings:()=>({width:1379,height:792})};
            r.stream={getVideoTracks:()=>[r.track],getTracks:()=>[r.track]};
            r.tick=async(ms=510)=>{r.clock+=ms;r.media+=1;const cb=r.callback;r.callback=null;if(cb)cb(r.clock,{mediaTime:r.media});await wait(0);};
            r.session=GameCapture.createSession({layout:M.defaultLayout(),products:()=>products,getDisplayMedia:()=>Promise.resolve(r.stream),createVideo:()=>src,
                createOcr:()=>({prepare:async()=>{},dispose:async()=>{}}),onDiagnostic:d=>r.diag.push(d),onState:s=>r.states.push(s),...extra});
            r.events=type=>r.diag.length?r.diag.at(-1).events.filter(e=>e.type===type).length:0;
            return r;
        }
        {const reads=[],r=rig({readFrame:()=>new Promise((res,rej)=>reads.push({res,rej}))});await r.session.prepare();await r.session.start();
            r.paint(65);for(let i=0;i<5;i++)await r.tick();ok(reads.length===1&&r.session.queueSize===1,'busy OCR queues the latest stable frame');
            r.paint(150);await r.tick();reads[0].res(detail('商品A'));await wait(0);
            ok(reads.length===1&&r.session.queueSize===0,'queued frame from a superseded screen is dropped, not read');
            for(let i=0;i<10&&reads.length<2;i++)await r.tick();reads[1].res(detail('商品A'));await wait(0);
            for(let i=0;i<10&&reads.length<3;i++)await r.tick();await r.tick();await r.tick();const queued=r.session.queueSize;
            reads[2].res(detail('商品A'));await wait(0);
            ok(queued===1&&r.session.queueSize===0&&reads.length===3,'frame queued behind the confirming read is discarded');
            await r.session.dispose();}
        {const r=rig({readFrame:()=>Promise.reject(new Error('识别崩溃'))});await r.session.prepare();await r.session.start();r.paint(65);for(let i=0;i<3;i++)await r.tick();await wait(0);
            ok(r.events('ocr-error')===1&&r.states.at(-1).includes('识别崩溃'),'OCR failure clears association and is reported');await r.session.dispose();}
        {const r=rig({diagnosticsOnly:true,createOcr:o=>({prepare:async()=>{o.onProgress({label:'下载模型 50%'});},dispose:async()=>{}})});
            ok(r.session.freeze()===null,'freeze before sharing returns nothing');await r.session.prepare();ok(r.states.includes('下载模型 50%'),'model progress forwarded');
            await r.session.start();document.dispatchEvent(new Event('visibilitychange'));ok(r.events('visibility')===1,'visibility change logged');
            await r.tick();r.track.muted=true;await r.tick();ok(r.events('invalid-frame')===1,'frame from a muted track rejected');r.track.muted=false;
            r.source.width=0;await r.tick();ok(r.events('read-error')===1,'unreadable frame reported');r.source.width=1379;r.paint(70);
            const still=r.session.freeze();ok(still&&still.width===1379&&still.height===792&&r.session.paused,'freeze copies the frame and pauses');r.session.resume();
            let threw=false;try{r.session.setLayout({});}catch(e){threw=e.message==='区域无效';}const next=M.defaultLayout();next.aspect=1379/792;r.session.setLayout(next);
            ok(threw&&r.events('layout-change')===1,'invalid layout rejected; valid layout applied');
            r.clock-=10000;await r.tick();const published=r.diag.length;await wait(1100);
            ok(r.events('frame-gap')===1&&r.diag.length>published+1&&r.diag.at(-1).longestFrameGapMs>=3000,'watchdog reports a stalled stream once, then keeps publishing');
            await r.session.dispose();}
        {const original=navigator.mediaDevices.getDisplayMedia;navigator.mediaDevices.getDisplayMedia=undefined;const diagU=[];const s=GameCapture.createSession({onDiagnostic:d=>diagU.push(d)});
            let rejected=false;try{await s.start();}catch(e){rejected=e.message.includes('不支持');}navigator.mediaDevices.getDisplayMedia=original;
            ok(rejected&&diagU.at(-1).events.some(e=>e.type==='unsupported'),'start on unsupported browser rejects with reason');await s.dispose();}
        {const r=rig({getDisplayMedia:()=>{throw new TypeError('picker unavailable');}});let name='';try{await r.session.start();}catch(e){name=e.name;}
            ok(name==='TypeError'&&r.events('share-error')===1&&!r.session.active,'synchronous picker failure rejects');await r.session.dispose();}
        {let grant;const r=rig({getDisplayMedia:()=>new Promise(res=>{grant=res;})});const started=r.session.start();await r.session.stop();grant(r.stream);await started;
            ok(r.stops===1&&!r.session.active&&r.callback===null,'stream granted after stop is released immediately');await r.session.dispose();}
        {let played;const r=rig();r.source.play=()=>new Promise(res=>{played=res;});const started=r.session.start();await wait(0);r.session.stop();played();await started;
            ok(r.stops===1&&!r.session.active&&r.callback===null,'stop while video starts leaves nothing running');await r.session.dispose();}

        // Engine edges not reached through the scheduler.
        {const lp=[{name:'商品B',basePrice:2000,discount:0}],seen=[];const bare=new M.Engine({products:()=>lp});
            ok(!bare.accept({page:'unknown'},bare.begin())&&bare.page===null&&bare.rounds===0,'unknown page resets the engine');
            let last=false;for(let i=0;i<M.TUNING.MAX_ROUNDS;i++)last=bare.accept(friend(),bare.begin());ok(last&&bare.done,'last round accepted even without a repeat');
            const local=new M.Engine({products:()=>lp,onCandidate:c=>seen.push(c)});local.context={name:'商品B',local:3000,image:''};
            for(let i=0;i<M.TUNING.MAX_ROUNDS;i++)local.accept(friend(),local.begin());
            ok(seen.length===1&&seen[0].reasons.some(s=>s.includes('游戏本地价与计算器相差')),'game local price far from calculator price flagged');}

        // No-scroll mode trusts only a newly confirmed detail -> friend transition.
        const noScroll=M.defaultLayout();noScroll.noScroll=true;
        const rawOcr={recognizeRegions:async(frame,regions)=>Object.fromEntries(Object.keys(regions).map(k=>[k,{text:k==='friendTitle'?'好友价格':k==='name'?'好友#1':k==='price'?'3300':'',confidence:99}]))};
        const testFrame=document.createElement('canvas');testFrame.width=1367;testFrame.height=706;
        ok(!(await GameCapture.readFrame(rawOcr,testFrame,noScroll,null)).top&&(await GameCapture.readFrame(rawOcr,testFrame,noScroll,{name:'商品A'})).top,'no-scroll mode requires fresh detail context');

        // Integration uses the actual Vue page, formal import and persistent quotation editing.
        localStorage.clear();localStorage.setItem('products',JSON.stringify(products));localStorage.setItem('friends',JSON.stringify([{name:'游戏采集',discounts:{}}]));
        const frame=document.getElementById('app');await new Promise(r=>{frame.onload=r;frame.src='index.html';});
        for(let i=0;i<200&&!frame.contentDocument.getElementById('app').__vue_app__;i++)await wait(100);
        const win=frame.contentWindow,vm=frame.contentDocument.getElementById('app').__vue_app__._instance.proxy;
        let callbacks,uiDisposed=0,savedLayout;
        win.GameCapture.createSession=opts=>{callbacks=opts;return {supportError:()=>'',prepare:async()=>{},start:async()=>{},setDiagnosticsOnly:()=>{},pause:()=>{},resume:()=>{},freeze:()=>testFrame,setLayout:l=>{savedLayout=l;},stop:async()=>{opts.onStopped();},dispose:async()=>{uiDisposed++;}};};
        await vm.openCaptureDialog();await vm.$nextTick();ok(!!frame.contentDocument.querySelector('.capture-dialog'),'capture panel renders');
        vm.capture.running=true;vm.beginCalibration();await vm.$nextTick();ok(vm.capture.calibrating&&vm.capture.snapshot&&vm.capture.paused,'calibration freezes preview and pauses recognition');vm.saveCalibration();ok(savedLayout.aspect===1367/706&&JSON.parse(localStorage.getItem('gameCaptureLayout:v1')).version===1&&!vm.capture.snapshot,'calibration saves separate layout and frees full-frame preview');await vm.stopCapture();
        callbacks.onCandidate({...row,image:'',reasons:[],checked:true});callbacks.onCandidate({...row,id:'b',productName:'商品B',checked:false,image:'',reasons:['待核对']});
        ok(vm.friends.length===1&&vm.canImportCapture,'review leaves formal data unchanged');
        vm.capture.rows[0].price=4701;vm.editCaptureRow(vm.capture.rows[0]);vm.confirmCapture();await vm.$nextTick();
        const stored=JSON.parse(localStorage.getItem('friends'));ok(stored.length===2&&stored[1].quotes['商品A'].price===4701&&!stored[1].quotes['商品B'],'partial edited import only updates checked existing products');
        const restored=document.createElement('iframe');document.body.appendChild(restored);await new Promise(r=>{restored.onload=r;restored.src='index.html?restore';});
        const restoredVm=restored.contentDocument.getElementById('app').__vue_app__._instance.proxy;
        ok(restoredVm.friends[1].quotes['商品A'].price===4701&&restoredVm.bestPrice(restoredVm.products[0])===4701,'fresh page restores and ranks saved capture quotation');restoredVm.$.appContext.app.unmount();restored.remove();
        ok(stored[1].quotes['商品A'].manuallyModified&&uiDisposed===1,'manual review marked; close disposes session');
        ok(vm.bestPrice(products[0])===4701&&vm.bestFriendIndex(products[0])===1,'manual and capture quotes rank together');
        vm.products[0].discount=200;ok(vm.friendPrice(vm.products[0],vm.friends[1])===4701,'discount change never mutates absolute quotation');
        const capturedAt=vm.friends[1].quotes['商品A'].capturedAt;vm.editCaptureQuote(vm.friends[1],vm.products[0],'price','4801');ok(vm.friends[1].quotes['商品A'].capturedAt===capturedAt&&vm.friends[1].quotes['商品A'].manuallyModified,'management edit preserves original capture time');
        vm.openProductDialog(0);vm.newProduct.name='改名A';vm.submitProduct();ok(vm.friends[1].quotes['改名A'].price===4801&&!vm.friends[1].quotes['商品A'],'rename migrates quote');
        vm.removeProduct(0);ok(!vm.friends[1].quotes['改名A'],'deleting product deletes quote');
        vm.friends=[{source:'game-capture',name:'游戏采集',quotes:{},discounts:{}}];ok(vm.bestPrice(vm.products[0])===null&&vm.bestFriendIndex(vm.products[0])===-1&&vm.globalMaxDiff.productName==='','only missing capture quotes shows no available quotation');
        win.confirm=()=>true;await vm.openCaptureDialog();callbacks.onCandidate({...row,id:'unsaved',image:'crop',reasons:[]});vm.closeDialog();await vm.$nextTick();ok(vm.capture.rows.length===0,'closing discards transient rows and images');
        await vm.openCaptureDialog();callbacks.onCandidate({...row,id:'cancel-close',image:'crop',reasons:[]});win.confirm=()=>false;vm.closeDialog();ok(vm.dialog==='capture'&&vm.capture.rows.length===1,'cancel discard preserves review results');win.confirm=()=>true;
        vm.openImportDialog();ok(vm.dialog==='import'&&vm.capture.rows.length===0,'image import and capture sessions mutually exclusive');vm.closeDialog();
        // Panel methods through the real Vue instance, each with a scripted session.
        {const doc=frame.contentDocument,ev=(x,y)=>({preventDefault(){},currentTarget:{setPointerCapture(){}},clientX:x,clientY:y,pointerId:1});
        const stillFrame=()=>{const c=document.createElement('canvas');c.width=1367;c.height=706;c.getContext('2d').fillRect(0,0,300,200);return c;};
        let starts=0;const modes=[];
        const fake=(over={})=>{win.GameCapture.createSession=opts=>{callbacks=opts;return {supportError:()=>'',prepare:async()=>{},start:async()=>{starts++;},setDiagnosticsOnly:v=>modes.push(v),pause(){},resume(){},freeze:stillFrame,setLayout(){},stop:async()=>{opts.onStopped();},dispose:async()=>{},...over};};};
        vm.products=[{name:'商品A',basePrice:2000,discount:0},{name:'商品B',basePrice:2000,discount:0}];
        localStorage.setItem('gameCaptureLayout:v1','{');fake();await vm.openCaptureDialog();await vm.$nextTick();localStorage.removeItem('gameCaptureLayout:v1');
        ok(vm.captureLayout.aspect===null&&vm.capture.ready,'corrupt saved layout falls back to the default');
        const shown=doc.createElement('i');callbacks.onVideo(shown);callbacks.onState('等待商品详情');callbacks.onDiagnostic({events:[],samples:3});
        ok(shown.parentNode===vm.$refs.captureVideo&&vm.capture.status==='等待商品详情'&&vm.capture.diagnostic.samples===3,'session video, state and diagnostics reach the panel');
        vm.startCapture();await wait(0);ok(starts===1&&vm.capture.running&&modes.at(-1)===false,'start shares the window with recognition on');
        vm.startCapture();ok(starts===1,'second start while running ignored');
        vm.toggleCapture();ok(vm.capture.paused,'toggle pauses');vm.toggleCapture();ok(!vm.capture.paused,'toggle resumes');
        vm.beginCalibration();await vm.$nextTick();await doc.querySelector('.calibration-image img').decode();
        const box=vm.$refs.calibrationImage.getBoundingClientRect(),nameRect=vm.captureLayout.detail.name,x0=nameRect.x,w0=nameRect.w,h0=nameRect.h;
        vm.beginRegionDrag(ev(10,10),'name');vm.moveRegionDrag(ev(10+box.width*.1,10));vm.endRegionDrag();vm.moveRegionDrag(ev(500,500));
        ok(Math.abs(nameRect.x-x0-.1)<1e-6&&nameRect.w===w0&&vm.capture.preview.startsWith('data:image/png'),'dragging moves the region and refreshes the preview; moves after release ignored');
        vm.beginRegionDrag(ev(0,0),'name',true);vm.moveRegionDrag(ev(box.width*.05,box.height*.02));vm.endRegionDrag();
        ok(Math.abs(nameRect.w-w0-.05)<1e-6&&Math.abs(nameRect.h-h0-.02)<1e-6&&Math.abs(nameRect.x-x0-.1)<1e-6,'resize handle grows the region in place');
        vm.beginRegionDrag(ev(0,0),'name');vm.moveRegionDrag(ev(box.width*5,0));vm.endRegionDrag();ok(Math.abs(nameRect.x+nameRect.w-1)<1e-9,'drag clamps the region inside the frame');
        vm.capture.field='content';vm.capture.preview='';vm.updateCalibrationPreview();ok(vm.capture.preview.startsWith('data:image/png'),'content range previews the whole area');
        vm.capture.field='name';nameRect.w=2;vm.saveCalibration();ok(vm.capture.error.includes('区域必须位于画面内')&&vm.capture.calibrating,'region outside the frame cannot be saved');nameRect.w=w0;
        const proto=win.Storage.prototype,setItem=proto.setItem;proto.setItem=()=>{throw new Error('配额已满');};
        try{vm.saveCalibration();}finally{proto.setItem=setItem;}
        ok(vm.capture.error.includes('配额已满')&&vm.capture.calibrating,'storage failure keeps calibration open');
        vm.saveCalibration();ok(!vm.capture.calibrating&&!vm.capture.paused&&!vm.capture.error,'saved calibration resumes recognition');
        callbacks.onCandidate({...row,id:'r1',productName:'商品A',observedLocalPrice:3000,image:'',reasons:[],checked:true});
        callbacks.onCandidate({...row,id:'r2',productName:'',detectedName:'商品AA',friendName:'别人#1',price:2100,image:'',reasons:['待选择商品'],checked:false});
        await vm.$nextTick();const [r1,r2]=vm.capture.rows;
        ok(vm.captureCount===2&&vm.capturePending===1,'counts collected products and pending rows');
        ok(vm.captureLocal(r1)===2000&&vm.captureWarnings(r1).includes('游戏与计算器本地价不同'),'game local price that differs from the calculator is warned');
        r1.observedLocalPrice=2001;ok(vm.captureWarnings(r1)==='重复确认通过','matching local price passes');
        ok(vm.captureLocal(r2)===null&&vm.captureSuggestions(r2).includes('商品A')&&vm.captureWarnings(r2)==='待选择商品','unassigned row lists near product names');
        const cap=vm.friends.find(f=>f.source==='game-capture'),pB=vm.products[1];
        vm.editCaptureQuote(cap,pB,'friendName','备注');ok(!Object.hasOwn(cap.quotes,'商品B'),'a note alone creates no quote');
        vm.editCaptureQuote(cap,pB,'price','0');ok(!Object.hasOwn(cap.quotes,'商品B'),'invalid typed price rejected');
        vm.editCaptureQuote(cap,pB,'price','2300');const q=cap.quotes['商品B'];
        ok(q.price===2300&&q.manuallyModified&&q.capturedAt===null&&vm.captureOld({productName:'商品B'})===2300,'typed price creates a manual quote');
        vm.clearCaptureQuote(cap,pB);ok(!Object.hasOwn(cap.quotes,'商品B')&&vm.captureOld({productName:'商品B'})===null,'quote cleared from management');
        const clicked=[],revoked=[],click=win.HTMLAnchorElement.prototype.click,revoke=win.URL.revokeObjectURL;
        win.HTMLAnchorElement.prototype.click=function(){clicked.push(this.download);};win.URL.revokeObjectURL=u=>revoked.push(u);
        try{vm.capture.browserVersion='Edge 142';vm.exportCaptureDiagnostic();await wait(1100);}finally{win.HTMLAnchorElement.prototype.click=click;win.URL.revokeObjectURL=revoke;}
        const exported=revoked.length?await (await fetch(revoked[0])).json():{};if(revoked.length)URL.revokeObjectURL(revoked[0]);
        ok(clicked[0]==='game-capture-diagnostic.json'&&revoked.length===1&&exported.schema==='game-capture-diagnostic:v1'&&exported.browserVersion==='Edge 142'&&exported.samples===3,'diagnostic export downloads JSON and revokes its URL');
        await vm.stopCapture();ok(!vm.capture.running&&!vm.capture.stopping,'stop ends the run');
        const stale=callbacks;await vm.releaseCapture();
        stale.onState('迟到');stale.onCandidate({...row,id:'late',image:'',reasons:[]});stale.onDiagnostic({events:[],samples:99});stale.onStopped();stale.onVideo(doc.createElement('i'));
        ok(vm.capture.rows.length===0&&vm.capture.status==='模型尚未加载'&&!vm.capture.diagnostic.samples,'callbacks from a released session are ignored');
        vm.toggleCapture();vm.beginCalibration();ok(!vm.capture.paused&&!vm.capture.calibrating,'controls without a session do nothing');
        fake({supportError:()=>'此浏览器不支持窗口共享'});await vm.openCaptureDialog();
        ok(vm.capture.error.includes('不支持')&&vm.capture.status==='窗口无法读取'&&!vm.capture.ready,'unsupported browser shown before model load');
        vm.capture.error='';await vm.prepareCapture();
        ok(vm.capture.error.includes('不支持')&&!vm.capture.loading,'retry on an unsupported session reports it without loading');
        let grant,prepares=0;fake({prepare:()=>{prepares++;return new Promise(r=>{grant=r;});}});const opening=vm.openCaptureDialog();await vm.$nextTick();await wait(0);
        const loading=vm.capture.loading;await vm.prepareCapture();grant();await opening;
        ok(loading&&prepares===1&&!vm.capture.loading&&vm.capture.ready,'second prepare while loading ignored');
        fake({prepare:()=>Promise.reject(new win.OcrRecognizer.CancelledError())});await vm.openCaptureDialog();await vm.$nextTick();ok(!vm.capture.error&&!vm.capture.ready,'cancelled model load shows no error');
        fake({prepare:()=>Promise.reject(new Error('模型损坏'))});await vm.openCaptureDialog();await vm.$nextTick();ok(vm.capture.error.includes('模型损坏')&&!vm.capture.loading,'model load failure shown');
        fake({freeze:()=>null});await vm.openCaptureDialog();vm.capture.running=true;vm.beginCalibration();ok(vm.capture.error.includes('请先共享')&&!vm.capture.calibrating,'calibration without a readable frame is refused');
        let started=0;fake({start:()=>{started++;return Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));}});
        await vm.openCaptureDialog();vm.capture.diagnosticsOnly=true;vm.startCapture();await wait(0);
        ok(started===1&&modes.at(-1)===true&&vm.capture.error.includes('拒绝')&&!vm.capture.running,'sharing refusal reported, diagnostics mode forwarded');
        vm.capture.ready=false;vm.capture.diagnosticsOnly=false;vm.startCapture();ok(started===1,'start before ready ignored');
        fake({start:()=>Promise.reject(new Error('设备忙'))});await vm.openCaptureDialog();vm.capture.ready=true;vm.startCapture();await wait(0);
        ok(vm.capture.error==='设备忙'&&!vm.capture.running,'other start failure reported verbatim');
        fake();await vm.openCaptureDialog();vm.capture.rows.push({...row,image:'data:image/png,x',detailImage:'data:image/png,y',reasons:[]});
        win.confirm=()=>false;ok(vm.closeCapture()===false&&vm.capture.rows[0].image,'cancelling the discard keeps the review');
        win.confirm=()=>true;const closing=vm.openCaptureDialog();ok(!vm.capture.rows.some(r=>r.image),'reopening clears transient images before the new session');await closing;
        fake();}
        vm.resetData();await vm.$nextTick();ok(JSON.parse(localStorage.getItem('friends')).length===0,'reset clears capture source');
    }catch(e){log.push('ERROR '+(e.stack||e));}
    const fails=log.filter(l=>/^(FAIL|ERROR)/.test(l)).length;
    document.getElementById('out').textContent=log.join('\n')+'\n'+(fails?'FAILED '+fails:'ALL PASSED '+log.length);
})();
