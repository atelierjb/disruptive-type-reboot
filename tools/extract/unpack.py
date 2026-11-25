import struct, sys, os
src, out = sys.argv[1], sys.argv[2]
d = open(src,'rb').read()
assert d[:16]==b'UnityWebData1.0\0'
hdr = struct.unpack_from('<I', d, 16)[0]
p = 20
while p < hdr:
    off, size, nl = struct.unpack_from('<III', d, p); p += 12
    name = d[p:p+nl].decode(); p += nl
    fp = os.path.join(out, name); os.makedirs(os.path.dirname(fp), exist_ok=True)
    open(fp,'wb').write(d[off:off+size]); print(size, name)
