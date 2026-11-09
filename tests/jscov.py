"""JS line/function coverage from Chromium's V8 precise coverage (CDP Profiler domain).

Coverage is merged across test pages and across iframe reloads (each load of a script is a
separate V8 script instance; their counts are summed per source offset). Only files under
docs/js/ are reported; docs/vendor/ and test code are ignored.
"""
import pathlib
import re
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / 'docs' / 'js'
# 空行、注释行、只有括号/分号的行不计入可执行行（例如 return 之后单独的 "}"）
NON_CODE = re.compile(r'^\s*$|^\s*//|^\s*/?\*|^[\s{}()\[\];,]*$')


class SourceFile:
    def __init__(self, path):
        self.path = path
        self.rel = path.relative_to(ROOT).as_posix()
        self.text = path.read_text(encoding='utf-8', newline='')
        # V8 偏移量按 UTF-16 码元计算
        self.lines = []  # (start, end, text) in UTF-16 offsets, end excludes line terminator
        offset = 0
        for raw in self.text.split('\n'):
            body = raw[:-1] if raw.endswith('\r') else raw
            size = len(body.encode('utf-16-le')) // 2
            self.lines.append((offset, offset + size, body))
            offset += len(raw.encode('utf-16-le')) // 2 + 1
        self.size = offset
        self.counts = [0] * self.size
        self.functions = {}  # start offset -> [name, count]
        self.loaded = 0

    def line_of(self, offset):
        lo, hi = 0, len(self.lines) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.lines[mid][0] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    def add_script(self, functions):
        self.loaded += 1
        counts = [0] * self.size
        ranges = [r for fn in functions for r in fn['ranges']]
        # 外层范围先写，内层范围覆盖外层
        for r in sorted(ranges, key=lambda r: (r['startOffset'], -r['endOffset'])):
            s, e = r['startOffset'], min(r['endOffset'], self.size)
            if s < e:
                counts[s:e] = [r['count']] * (e - s)
        for i, c in enumerate(counts):
            self.counts[i] += c
        for fn in functions:
            whole = fn['ranges'][0]
            start = whole['startOffset']
            if start == 0 and not fn['functionName']:
                continue  # 脚本顶层
            entry = self.functions.setdefault(start, [fn['functionName'], 0])
            entry[1] += whole['count']

    def line_hits(self):
        """[(line_no, count)] for executable lines; count = max hits of any character on the line."""
        hits = []
        for no, (s, e, body) in enumerate(self.lines, 1):
            if NON_CODE.match(body):
                continue
            chars, pos = [], s
            for ch in body:
                if not ch.isspace():
                    chars.append(self.counts[pos])
                pos += 2 if ord(ch) > 0xFFFF else 1
            hits.append((no, max(chars) if chars and self.loaded else 0))
        return hits

    def function_hits(self):
        out, seen = [], set()
        for start, (name, count) in sorted(self.functions.items()):
            line = self.line_of(start)
            label = name or '(anonymous)'
            if label in seen or not name:
                label = '%s@L%d' % (label, line)
            seen.add(label)
            out.append((line, label, count))
        return out


class Collector:
    """Accumulates V8 coverage for docs/js/**.js across pages."""

    def __init__(self):
        self.files = {p.resolve(): SourceFile(p) for p in sorted(SOURCE_DIR.rglob('*.js'))}

    def start(self, page):
        cdp = page.context.new_cdp_session(page)
        cdp.send('Profiler.enable')
        cdp.send('Profiler.startPreciseCoverage', {'callCount': True, 'detailed': True})
        return cdp

    def take(self, cdp):
        """Read and reset counters; safe to call repeatedly (counts are summed)."""
        result = cdp.send('Profiler.takePreciseCoverage')['result']
        for script in result:
            src = self._source_for(script['url'])
            if src:
                src.add_script(script['functions'])
        return result

    def stop(self, cdp):
        self.take(cdp)
        cdp.send('Profiler.stopPreciseCoverage')
        cdp.detach()

    def _source_for(self, url):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return None
        path = (ROOT / urllib.parse.unquote(parsed.path).lstrip('/')).resolve()
        return self.files.get(path)

    # ---------- 报告 ----------
    def summary(self):
        rows = []
        for src in self.files.values():
            lines = src.line_hits()
            fns = src.function_hits()
            rows.append({
                'file': src.rel, 'loaded': src.loaded > 0,
                'lines': (sum(1 for _, c in lines if c), len(lines)),
                'functions': (sum(1 for _, _, c in fns if c), len(fns)),
                'uncovered_lines': [n for n, c in lines if not c],
                'uncovered_functions': [(l, name) for l, name, c in fns if not c],
            })
        return rows

    def write_lcov(self, path):
        out = []
        for src in self.files.values():
            out.append('TN:')
            out.append('SF:' + str(src.path))
            fns = src.function_hits()
            for line, name, _ in fns:
                out.append('FN:%d,%s' % (line, name))
            for _, name, count in fns:
                out.append('FNDA:%d,%s' % (count, name))
            out.append('FNF:%d' % len(fns))
            out.append('FNH:%d' % sum(1 for _, _, c in fns if c))
            lines = src.line_hits()
            for no, count in lines:
                out.append('DA:%d,%d' % (no, count))
            out.append('LF:%d' % len(lines))
            out.append('LH:%d' % sum(1 for _, c in lines if c))
            out.append('end_of_record')
        path.write_text('\n'.join(out) + '\n', encoding='utf-8')


def ranges(numbers):
    """[1,2,3,7,9,10] -> '1-3, 7, 9-10'"""
    parts, start, prev = [], None, None
    for n in numbers:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            parts.append(str(start) if start == prev else '%d-%d' % (start, prev))
            start = prev = n
    if start is not None:
        parts.append(str(start) if start == prev else '%d-%d' % (start, prev))
    return ', '.join(parts)


def pct(hit, total):
    return 100.0 * hit / total if total else 100.0


def print_report(rows, show_uncovered=True):
    print('\nJS coverage (docs/js)')
    print('  %-28s %16s %16s' % ('file', 'lines', 'functions'))
    th = tt = fh = ft = 0
    for r in rows:
        (lh, lt), (fh_, ft_) = r['lines'], r['functions']
        th, tt, fh, ft = th + lh, tt + lt, fh + fh_, ft + ft_
        note = '' if r['loaded'] else '  (never loaded)'
        print('  %-28s %6.1f%% %4d/%-4d %6.1f%% %3d/%-3d%s' % (r['file'][len('docs/js/'):], pct(lh, lt), lh, lt, pct(fh_, ft_), fh_, ft_, note))
    print('  %-28s %6.1f%% %4d/%-4d %6.1f%% %3d/%-3d' % ('TOTAL', pct(th, tt), th, tt, pct(fh, ft), fh, ft))
    if show_uncovered:
        for r in rows:
            if r['uncovered_functions'] or r['uncovered_lines']:
                print('\n  %s' % r['file'])
                if r['uncovered_functions']:
                    print('    uncovered functions: ' + ', '.join(n if '@L' in n else '%s (L%d)' % (n, l) for l, n in r['uncovered_functions']))
                if r['uncovered_lines']:
                    print('    uncovered lines:     ' + ranges(r['uncovered_lines']))
    return pct(th, tt)
