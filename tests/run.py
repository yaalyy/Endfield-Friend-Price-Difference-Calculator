"""Headless test runner: starts serve.py, opens each test page, reports failures, sets the exit code.

Usage:
    python tests/run.py                  # unit, app, ui
    python tests/run.py app              # only tests/app.html
    python tests/run.py e2e              # real OCR (slow, not run by default)
    python tests/run.py -v               # print every line, not just failures
    python tests/run.py --browser msedge # use installed Edge instead of Playwright's Chromium
    python tests/run.py --headed         # show the browser window for debugging
    python tests/run.py --coverage       # also report JS coverage of docs/js, write coverage/lcov.info
    python tests/run.py --coverage --min-coverage 80   # fail (exit 1) if total line coverage < 80%

Requires: pip install playwright && python -m playwright install chromium
Exit code: 0 all passed, 1 a test failed / errored / timed out, 2 setup problem.
"""
import argparse
import pathlib
import re
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / 'tests'
DEFAULT_PAGES = ['unit', 'app', 'ui']
SLOW_PAGES = {'e2e': 300}
# 每个测试页结束时在 #out 末行写入其中一个标记
DONE_JS = r"""() => { const el = document.getElementById('out');
    return !!el && /^(ALL PASSED \d+|FAILED \d+|DONE)$/m.test(el.textContent); }"""

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(errors='backslashreplace')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def start_server(port):
    proc = subprocess.Popen([sys.executable, '-I', str(TESTS / 'serve.py'), str(port)], cwd=ROOT)
    deadline = time.time() + 10
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError('serve.py exited with code %s' % proc.returncode)
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError('serve.py did not start listening on port %d' % port)


def classify(lines):
    """Split page output into results. ERROR lines carry their indented stack trace."""
    passed, failed, misses = [], [], []
    last_ok = None
    i = 0
    while i < len(lines):
        line = lines[i]
        # 标记后必须跟空白，避免把汇总行 "FAILED 2" 当成一个失败
        m = re.match(r'^(ok|FAIL|MISS|ERROR)\s+(.*)$', line)
        tag, rest = (m.group(1), m.group(2).strip()) if m else (None, '')
        if tag == 'ok':
            passed.append(rest)
            last_ok = rest
        elif tag == 'FAIL':
            failed.append({'kind': 'FAIL', 'name': rest, 'detail': []})
        elif tag == 'MISS':
            misses.append(rest)
        elif tag == 'ERROR':
            detail = []
            while i + 1 < len(lines) and lines[i + 1].startswith((' ', '\t')) and not lines[i + 1].startswith('     '):
                i += 1
                detail.append(lines[i].strip())
            if last_ok:
                detail.append('last passing test before the error: ' + last_ok)
            failed.append({'kind': 'ERROR', 'name': rest, 'detail': detail})
        i += 1
    return passed, failed, misses


def on_console(msg, page_errors):
    if msg.type != 'error':
        return
    url = msg.location.get('url') or ''
    # 浏览器自动请求的 favicon，以及应用关闭导入弹窗后已释放的预览图 blob，都不是缺陷
    if msg.text.startswith('Failed to load resource') and (url.endswith('/favicon.ico') or url.startswith('blob:')):
        return
    page_errors.append('console: %s (%s)' % (msg.text, url))


def run_page(browser, port, name, timeout_s, verbose, collector=None):
    page = browser.new_page()
    cdp = collector.start(page) if collector else None
    page_errors = []
    page.on('pageerror', lambda e: page_errors.append(str(e)))
    page.on('console', lambda m: on_console(m, page_errors))
    started = time.time()
    timed_out = False
    try:
        page.goto('http://127.0.0.1:%d/tests/%s.html' % (port, name))
        page.wait_for_function(DONE_JS, timeout=timeout_s * 1000)
    except Exception as e:  # 超时或导航失败：仍读取已有输出，便于定位卡在哪一步
        timed_out = True
        page_errors.append('%s: %s' % (type(e).__name__, str(e).splitlines()[0]))
    try:
        text = page.inner_text('#out')
    except Exception:
        text = ''
    if cdp:
        collector.stop(cdp)
    page.close()
    elapsed = time.time() - started

    lines = text.splitlines()
    passed, failed, misses = classify(lines)
    if timed_out:
        last = passed[-1] if passed else '(none)'
        failed.append({'kind': 'TIMEOUT', 'name': 'page did not finish within %ds' % timeout_s,
                       'detail': ['last passing test: ' + last] + page_errors})
    elif page_errors:
        # 页面有未捕获异常或控制台错误，即使测试行全部 ok 也算失败
        failed.append({'kind': 'ERROR', 'name': 'uncaught page errors', 'detail': page_errors})
    if not timed_out and not passed and not failed:
        failed.append({'kind': 'ERROR', 'name': 'page reported no results', 'detail': lines[-5:]})

    status = 'FAIL' if failed else 'PASS'
    print('\n[%s] %s.html  %d passed, %d failed  (%.1fs)' % (status, name, len(passed), len(failed), elapsed))
    if verbose:
        for line in lines:
            print('    ' + line)
    for f in failed:
        print('  %-7s %s.html > %s' % (f['kind'], name, f['name']))
        for d in f['detail']:
            print('          ' + d)
    for m in misses:
        print('  MISS    %s.html > %s' % (name, m))
    return name, passed, failed


def main():
    parser = argparse.ArgumentParser(description='Run browser test pages headlessly.')
    parser.add_argument('pages', nargs='*', help='page names in tests/ without .html (default: %s)' % ' '.join(DEFAULT_PAGES))
    parser.add_argument('-v', '--verbose', action='store_true', help='print every output line')
    parser.add_argument('--browser', default=None, help='Playwright channel, e.g. msedge or chrome (default: bundled Chromium)')
    parser.add_argument('--headed', action='store_true', help='show the browser window')
    parser.add_argument('--timeout', type=int, default=120, help='seconds per page (default 120; e2e uses 300)')
    parser.add_argument('--coverage', action='store_true', help='collect JS coverage for docs/js (Chromium/Edge only)')
    parser.add_argument('--min-coverage', type=float, default=None, help='implies --coverage: fail if total line coverage is below this percent')
    args = parser.parse_args()

    pages = args.pages or DEFAULT_PAGES
    missing = [p for p in pages if not (TESTS / (p + '.html')).is_file()]
    if missing:
        print('unknown test page(s): ' + ', '.join(missing))
        return 2
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('Playwright not installed: pip install playwright && python -m playwright install chromium')
        return 2

    collector = None
    if args.coverage or args.min_coverage is not None:
        sys.path.insert(0, str(TESTS))  # python -I 不会把脚本目录加入 sys.path
        import jscov
        collector = jscov.Collector()

    port = free_port()
    server = start_server(port)
    results = []
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(channel=args.browser, headless=not args.headed)
            except Exception as e:
                print('could not launch browser: %s' % str(e).splitlines()[0])
                print('run: python -m playwright install chromium   (or pass --browser msedge)')
                return 2
            for name in pages:
                timeout = max(args.timeout, SLOW_PAGES.get(name, 0))
                results.append(run_page(browser, port, name, timeout, args.verbose, collector))
            browser.close()
    finally:
        server.terminate()
        server.wait(5)

    total_pass = sum(len(p) for _, p, _ in results)
    failures = [(n + '.html', f) for n, _, fs in results for f in fs]
    if collector:
        total = jscov.print_report(collector.summary())
        out_dir = ROOT / 'coverage'
        out_dir.mkdir(exist_ok=True)
        collector.write_lcov(out_dir / 'lcov.info')
        print('\n  lcov report: coverage/lcov.info')
        if args.min_coverage is not None and total < args.min_coverage:
            failures.append(('coverage', {'kind': 'COVER', 'name': 'line coverage %.1f%% is below --min-coverage %g%%' % (total, args.min_coverage)}))
    print('\n' + '=' * 60)
    if failures:
        print('FAILED: %d problem(s), %d passed' % (len(failures), total_pass))
        for n, f in failures:
            print('  %-7s %s > %s' % (f['kind'], n, f['name']))
        return 1
    print('ALL PASSED: %d tests in %d page(s)' % (total_pass, len(results)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
