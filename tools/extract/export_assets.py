import UnityPy, sys, os, struct, json
from PIL import Image
SRC, OUT = sys.argv[1], sys.argv[2]
env = UnityPy.load(SRC)
files = list(env.files.values())[0].files
for d in ('tex','ui','audio','cube'): os.makedirs(f'{OUT}/{d}', exist_ok=True)
for fn in ('sharedassets0.assets','sharedassets1.assets'):
    af = files[fn]
    for pid,o in af.objects.items():
        t=o.type.name
        if t=='Texture2D':
            d=o.read(); img=d.image
            sub='ui' if (d.m_Name.startswith(('sculpture_tags','interface','logotype','backbutton','moreinfo','disruptive','crosshair'))) else 'tex'
            img.save(f'{OUT}/{sub}/{d.m_Name}.png'); print('tex',d.m_Name,img.size,img.mode,d.m_TextureFormat)
        elif t=='AudioClip':
            d=o.read()
            for name,data in d.samples.items():
                open(f'{OUT}/audio/{d.m_Name}.wav','wb').write(data); print('audio',d.m_Name,pid,len(data))
        elif t=='Cubemap':
            tt=o.read_typetree()
            print('cubemap',tt['m_Name'],tt['m_TextureFormat'],tt['m_Width'],tt['m_MipCount'],len(tt['image data']), tt.get('m_StreamData'))
            import texture2ddecoder
            data=tt['image data']; w=tt['m_Width']
            face=len(data)//6
            for i in range(6):
                fd=data[i*face:i*face+w*w]  # DXT5 = 1 byte/pixel at mip0
                raw=texture2ddecoder.decode_bc3(fd,w,w)
                Image.frombytes('RGBA',(w,w),raw,'raw','BGRA').convert('RGB').save(f'{OUT}/cube/face{i}.png')
        elif t=='Material' and 'Aluminum' in o.read().m_Name:
            tt=o.read_typetree()
            for k,v in tt['m_SavedProperties']['m_TexEnvs']:
                print('texenv',k,v['m_Scale'],v['m_Offset'])
            print({k:v for k,v in tt['m_SavedProperties']['m_Floats']})
