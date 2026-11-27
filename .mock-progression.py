
import numpy as np, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

PW,PH = 640, 430          # panel size
COLS,ROWS = 2,3
GAP = 14
PAD = 16
random.seed(11); np.random.seed(11)

CTRL = [(0.05,0.50),(0.04,0.38),(0.08,0.24),(0.17,0.12),(0.30,0.05),(0.45,0.02),
        (0.60,0.03),(0.74,0.08),(0.86,0.17),(0.94,0.30),(0.97,0.45),(0.95,0.58),
        (0.88,0.66),(0.78,0.68),(0.70,0.67),(0.66,0.72),(0.56,0.76),(0.44,0.76),
        (0.34,0.72),(0.28,0.65),(0.25,0.61),(0.20,0.62),(0.12,0.60),(0.07,0.56)]

def catmull_closed(pts, per=18):
    out=[]; n=len(pts)
    for i in range(n):
        p0=pts[(i-1)%n]; p1=pts[i]; p2=pts[(i+1)%n]; p3=pts[(i+2)%n]
        for s in range(per):
            t=s/per; t2=t*t; t3=t2*t
            f=lambda a,b,c,d: 0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3)
            out.append((f(p0[0],p1[0],p2[0],p3[0]), f(p0[1],p1[1],p2[1],p3[1])))
    return out

CX,CY = PW/2, PH/2+6
BW,BH = 500, 396
def to_screen(x,y): return (CX-BW/2+x*BW, CY-BH/2+y*BH)
outline = catmull_closed(CTRL,18)
poly = [to_screen(x,y) for x,y in outline]
coarse = poly[::4]

def inside(px,py):
    c=False; n=len(poly)
    for i in range(n):
        x1,y1=poly[i]; x2,y2=poly[(i+1)%n]
        if ((y1>py)!=(y2>py)) and (px < (x2-x1)*(py-y1)/(y2-y1)+x1): c=not c
    return c

def boundary_dist(px,py):
    best=1e9
    for i in range(len(coarse)):
        x1,y1=coarse[i]; x2,y2=coarse[(i+1)%len(coarse)]
        dx,dy=x2-x1,y2-y1
        L=dx*dx+dy*dy
        t=0 if L==0 else max(0,min(1,((px-x1)*dx+(py-y1)*dy)/L))
        qx,qy=x1+t*dx,y1+t*dy
        d=math.hypot(px-qx,py-qy)
        if d<best: best=d
    return best

def fold_w(x,y):
    a=math.sin((x*3.1+y*1.7)*9.0)
    b=math.sin((y*3.4-x*1.2)*11.0)
    c=math.sin((x+y)*17.0)
    v=0.55+0.25*a+0.15*b+0.05*c
    return max(0.06,min(1.0,v))

def make_glow(size, core, halo):
    g=Image.new('L',(size,size),0); d=ImageDraw.Draw(g); c=size/2
    for r in range(int(c),0,-1):
        t=r/c
        v=(1-t)**2.2*halo + (max(0,(0.35-t)/0.35)**1.6)*core
        d.ellipse([c-r,c-r,c+r,c+r], fill=int(min(255,v*255)))
    return g

SPR = {s: make_glow(s, 0.95, 0.9) for s in (16,24,32,48,64,96)}

# ---- shared star field ----
stars=[(random.uniform(0,PW), random.uniform(0,PH), random.uniform(0.4,1.5), random.uniform(0.06,0.45)) for _ in range(420)]

def base_bg():
    img=Image.new('RGB',(PW,PH),(4,6,12)); d=ImageDraw.Draw(img)
    for sx,sy,sz,sa in stars:
        v=int(255*sa)
        d.ellipse([sx-sz/2,sy-sz/2,sx+sz/2,sy+sz/2], fill=(v,v,min(255,int(v*1.15))))
    glow=Image.new('RGB',(PW,PH),(0,0,0)); gd=ImageDraw.Draw(glow)
    for k in range(70,0,-1):
        t=k/70; r=int(300*t)+40
        v=int(16*(1-t)**2)
        gd.ellipse([CX-r,CY-r*0.78,CX+r,CY+r*0.78], fill=(v//3,v,v*2 if v*2<255 else 255))
    glow=glow.filter(ImageFilter.GaussianBlur(55))
    return Image.fromarray(np.clip(np.array(img).astype(int)+np.array(glow).astype(int),0,255).astype('uint8'))

BG = base_bg()

def place(n):
    pts=[]; tries=0
    rim = min(0.78, n/1100.0)
    while len(pts)<n and tries<n*400+2000:
        tries+=1
        x=random.uniform(0,1); y=random.uniform(0,1)
        sx,sy=to_screen(x,y)
        if not inside(sx,sy): continue
        if random.random() > fold_w(x,y)*0.85+0.15: continue
        if random.random() < rim and boundary_dist(sx,sy) > 22: continue
        ex=1-abs((x-0.5)/0.5)**2; ey=1-abs((y-0.5)/0.5)**2
        z=random.gauss(0,0.55)*math.sqrt(max(ex*ey,0.02))
        pts.append([sx,sy,max(-1,min(1,z)),random.random()])
    return pts

def render(n):
    img = BG.copy()
    frame_a = 0.17*max(0.0, 1-n/140.0)
    # ---- faint framework ----
    if frame_a > 0.004:
        lay=Image.new('RGB',(PW,PH),(0,0,0)); ld=ImageDraw.Draw(lay)
        v=int(255*frame_a)
        # dotted cortical outline
        for i in range(0,len(poly),3):
            x1,y1=poly[i]; x2,y2=poly[(i+1)%len(poly)]
            ld.line([x1,y1,x2,y2], fill=(v,v,min(255,int(v*1.25))), width=2)
        # interior folds (sulci)
        for (a,b) in [((0.24,0.61),(0.70,0.47)), ((0.50,0.02),(0.42,0.54)), ((0.80,0.04),(0.72,0.70))]:
            x1,y1=to_screen(*a); x2,y2=to_screen(*b)
            ld.line([x1,y1,x2,y2], fill=(v//2,v//2,int(v*0.7)), width=1)
        lay=lay.filter(ImageFilter.GaussianBlur(1.1))
        img=Image.fromarray(np.clip(np.array(img).astype(int)+np.array(lay).astype(int),0,255).astype('uint8'))
        # interior dust
        d=ImageDraw.Draw(img)
        dn=int(520*(1-n/140.0))
        for _ in range(max(0,dn)):
            x=random.uniform(0,1); y=random.uniform(0,1)
            sx,sy=to_screen(x,y)
            if not inside(sx,sy): continue
            if random.random()>fold_w(x,y): continue
            a=random.uniform(0.04,0.11)
            vv=int(255*a)
            d.point((sx,sy), fill=(vv,vv,min(255,int(vv*1.3))))

    if n==0:
        return img

    pts = place(n)
    # ---- links ----
    thr = 118 if n<=120 else (86 if n<=300 else 62)
    link=Image.new('RGB',(PW,PH),(0,0,0)); ld=ImageDraw.Draw(link)
    for i in range(len(pts)):
        for j in range(i+1,len(pts)):
            dx=pts[i][0]-pts[j][0]; dy=pts[i][1]-pts[j][1]
            dd=dx*dx+dy*dy
            if dd < thr*thr:
                dist=math.sqrt(dd)
                a=int(88*(1-dist/thr))
                if a>3:
                    ld.line([pts[i][0],pts[i][1],pts[j][0],pts[j][1]], fill=(a,a,min(255,int(a*1.35))), width=1)
    link=link.filter(ImageFilter.GaussianBlur(0.5))
    img=Image.fromarray(np.clip(np.array(img).astype(int)+np.array(link).astype(int),0,255).astype('uint8'))

    # ---- nodes ----
    base_size = 62 if n<=40 else (46 if n<=150 else (36 if n<=400 else 27))
    base_bright = 1.0 if n<=40 else (0.86 if n<=150 else (0.70 if n<=400 else 0.55))
    acc=Image.new('RGB',(PW,PH),(0,0,0))
    for sx,sy,z,seed in sorted(pts, key=lambda p:p[2]):
        s=1.0/(1.0+(z+1)*0.35)
        bright=base_bright*(0.32+0.68*((z+1)/2))
        size=max(9,int(base_size*s))
        key=min(SPR.keys(), key=lambda k:abs(k-size))
        sp=SPR[key].resize((size,size), Image.LANCZOS)
        tint=Image.new('RGB',(size,size),(208,226,255))
        acc.paste(tint,(int(sx-size/2),int(sy-size/2)), sp.point(lambda v:int(v*bright)))
    img=Image.fromarray(np.clip(np.array(img).astype(int)+np.array(acc).astype(int),0,255).astype('uint8'))

    # ---- bloom ----
    small=img.resize((PW//4,PH//4), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
    bloom=small.resize((PW,PH), Image.LANCZOS)
    img=Image.fromarray(np.clip(np.array(img).astype(int)+(np.array(bloom).astype(int)*0.8).astype(int),0,255).astype('uint8'))

    # ---- tonemap: keeps dense cores from clipping to flat white ----
    arr=np.array(img).astype(np.float32)
    arr=255.0*(1.0-np.exp(-arr/205.0))
    return Image.fromarray(np.clip(arr,0,255).astype('uint8'))

STAGES=[(0,"0 条  ·  只有框架"),(25,"25 条  ·  星点初现"),(80,"80 条  ·  开始连成网"),
        (200,"200 条  ·  脑形浮现"),(450,"450 条  ·  皮层变厚"),(900,"900 条  ·  接近实体")]
try: font=ImageFont.truetype("C:/Windows/Fonts/msyh.ttc",15)
except Exception: font=ImageFont.load_default()
try: fsm=ImageFont.truetype("C:/Windows/Fonts/msyh.ttc",12)
except Exception: fsm=font

Wt=COLS*PW+(COLS-1)*GAP+PAD*2; Ht=ROWS*PH+(ROWS-1)*GAP+PAD*2
canvas=Image.new('RGB',(Wt,Ht),(8,10,16))
for idx,(n,cap) in enumerate(STAGES):
    p=render(n)
    r,c=divmod(idx,COLS)
    x=PAD+c*(PW+GAP); y=PAD+r*(PH+GAP)
    canvas.paste(p,(x,y))
    d=ImageDraw.Draw(canvas)
    d.text((x+14,y+12), cap, font=font, fill=(196,214,240))
    d.text((x+PW-92,y+14), "记忆识海", font=fsm, fill=(70,86,110))
canvas.save(r".refs/mock-progression.png")
print("ok", canvas.size)
