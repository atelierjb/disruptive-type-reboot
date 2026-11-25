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
            # The sky is an HDR cubemap stored as RGBM in DXT5 (m_LightmapFormat 5 = RGBMEncoded).
            # Gamma-space decode: rgb * alpha * 5. We then bake the AmbienceExposure skybox material
            # (tint * 2 [unity_ColorSpaceDouble in gamma] * exposure) and clamp, which is exactly
            # what reached the screen in the original.
            import texture2ddecoder, numpy as np
            tt=o.read_typetree()
            data=tt['image data']; w=tt['m_Width']
            face=len(data)//6
            sky = np.array([0.515, 0.498, 0.481]) * 2 * 0.9
            for i in range(6):
                raw=texture2ddecoder.decode_bc3(data[i*face:i*face+w*w],w,w)  # mip0: 1 byte/px
                px=np.frombuffer(raw,np.uint8).reshape(w,w,4).astype(np.float32)/255
                rgb=px[...,[2,1,0]] * px[...,3:4] * 5 * sky
                # Measured against screenshots of the running original, Unity's WebGL output was
                # softer than the straight decode (less clipping, less saturated): fitted as
                # 0.79 * x^0.82, which matches the reference pixels to within a few levels.
                rgb = 0.79 * np.power(rgb, 0.82)
                Image.fromarray((np.clip(rgb,0,1)*255+0.5).astype(np.uint8)).save(f'{OUT}/cube/face{i}.png')
            print('cubemap', tt['m_Name'], w)
        elif t=='Material' and 'Aluminum' in o.read().m_Name:
            tt=o.read_typetree()
            for k,v in tt['m_SavedProperties']['m_TexEnvs']:
                print('texenv',k,v['m_Scale'],v['m_Offset'])
            print({k:v for k,v in tt['m_SavedProperties']['m_Floats']})
