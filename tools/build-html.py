"""Bundle src/ into one self-contained HTML file: python3 tools/build-html.py out.html"""
import base64, re, sys, pathlib
src = pathlib.Path(__file__).resolve().parent.parent / 'src'
out = sys.argv[1] if len(sys.argv) > 1 else 'DayBrief.html'
h = (src / 'index.html').read_text()
css = (src / 'styles.css').read_text()
js = (src / 'app.js').read_text()
h = re.sub(r'\s*<meta http-equiv="Content-Security-Policy"[^>]*/>', '', h)
h = h.replace('<link rel="stylesheet" href="styles.css" />', '<style>\n' + css + '\n</style>')
h = h.replace('<script src="app.js"></script>', '<script>\n' + js.replace('</script>', '<\\/script>') + '\n</script>')
def data_uri(m):
    p = src / m.group(0)
    mime = 'image/webp' if p.suffix == '.webp' else 'image/png'
    return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()
h = re.sub(r'img/[\w-]+\.(?:webp|png)', data_uri, h)
pathlib.Path(out).write_text(h)
print('wrote', out, len(h) // 1024, 'KB')
