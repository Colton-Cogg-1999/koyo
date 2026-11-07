"""Generate small original test books; no downloaded or personal documents."""
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1])
with zipfile.ZipFile(root / 'fixture.epub', 'w') as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
    z.writestr('book.opf', '''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Open Shelves</dc:title><dc:creator>OmaReader test fixture</dc:creator></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="image" href="image.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>''')
    z.writestr('one.xhtml', '<html><body><h1>Open Shelves</h1><p>A library begins with an open door. Reading should belong to everyone, and knowledge grows when we share it. A reader needs room to pause, disagree, and return to a passage with a question of their own.</p><p>A book on your disk should remain yours to read. Notes should outlast the application that created them. A quiet voice can make a difficult page approachable, without turning every sentence into a transaction.</p><p>Tools should help people find their way through information. They should not decide who deserves to enter.</p><img src="image.svg"/><a href="two.xhtml#second">Next chapter</a></body></html>')
    z.writestr('two.xhtml', '<html><body><h1 id="second">Room for Everyone</h1><p>No account should stand between a person and a book already on their disk.</p></body></html>')
    z.writestr('image.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="48"><path d="M10 10 Q30 0 50 12 Q70 0 90 10 L90 42 Q70 32 50 44 Q30 32 10 42 Z M50 12 L50 44" fill="none" stroke="#527443" stroke-width="2"/><script>window.assetExecuted=true</script></svg>')

# A minimal PDF with portrait, landscape, and image-only-sized blank pages.
objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
for index, (width, height) in enumerate([(612,792),(792,612),(612,792)]):
    stream = '' if index == 2 else 'BT /F1 16 Tf 50 %d Td ' % (height-90) + ' '.join('(%s) Tj 0 -30 Td' % line for line in [f'Page {index+1} of the open reading guide', 'Books belong on open shelves.', 'A person can read, question, and learn.', 'Every paragraph leaves room for thought.', 'These words are a synthetic test fixture.']) + ' ET'
    stream_id = len(objects)+2
    objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>')
    objects.append(f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream')
body = b'%PDF-1.4\n'
offsets = [0]
for i, obj in enumerate(objects,1):
    offsets.append(len(body))
    body += f'{i} 0 obj\n{obj}\nendobj\n'.encode()
xref = len(body)
body += f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
body += ''.join(f'{offset:010d} 00000 n \n' for offset in offsets[1:]).encode()
body += f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
(root/'mixed-pages.pdf').write_bytes(body)
