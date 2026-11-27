
import numpy as np, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

random.seed(7); np.random.seed(7)
W,H = 1200, 800
CX,CY = W/2, H/2+10

# ---------- brain-shaped point cloud (no shell) ----------
# side-view brain outline in normalized coords, front at left
CTRL = [(0.05,0.50),(0.04,0.38),(0.08,0.24),(0.17,0.12),(0.30,0.05),(0.45,0.02),
        (0.60,0.03),(0.74,0.08),(0.86,0.17),(0.94,0.30),(0.97,0.45),(0.95,0.58),
        (0.88,0.66),(0.78,0.68),(0.70,0.67),(0.66,0.72),(0.56,0.76),(0.44,0.76),
        (0.34,0.72),(0.28,0.65),(0.25,0.61),(0.20,0.62),(0.12,0.60),(0.07,0.56)]

def catmull_closed(pts, per=14):
    out=[]; n=len(pts)
    for i in range(n):
        p0=pts[(i-1)%n]; p1=pts[i]; p2=pts[(i+1)%n]; p3=pts[(i+2)%n]
        for s in range(per):
            t=s/per; t2=t*t; t3=t2*t
            f=lambda a,b,c,d: 0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3)
            out.append((f(p0[0],p1[0],p2[0],p3[0]), f(p0[1],p1[1],p2[1],p3[1])))
    return out

outline = catmull_closed(CTRL, 16)
BW, BH = 760, 600
def to_screen(x,y): return (CX - BW/2 + x*BW, CY - BH/2 + y*BH)

# polygon test via matplotlib-free ray casting
poly = [to_screen(x,y) for x,y in outline]
def inside(px,py):
    c=False; n=len(poly)
    for i in range(n):
        x1,y1=poly[i]; x2,y2=poly[(i+1)%n]
        if ((y1>py)!=(y2>py)) and (px < (x2-x1)*(py-y1)/(y2-y1)+x1): c=not c
    return c

# sample nodes inside outline with 3D depth
nodes=[]
tries=0
while len(nodes)<300 and tries<40000:
    tries+=1
    x=random.uniform(0,1); y=random.uniform(0,1)
    sx,sy=to_screen(x,y)
    if not inside(sx,sy): continue
    # rim bias: keep a share of nodes close to the cortical boundary so the silhouette reads
    if len(nodes) % 3 == 0:
        best=1e9
        for k in range(0,len(poly),2):
            dd=math.hypot(poly[k][0]-sx, poly[k][1]-sy)
            if dd<best: best=dd
        if best>28: continue
    # depth: thicker in middle, thin at edges (ellipse profile)
    ex = 1-abs((x-0.5)/0.5)**2; ey = 1-abs((y-0.5)/0.5)**2
    t = max(0.0, ex*ey)
    z = random.gauss(0, 0.55)*math.sqrt(max(t,0.02))
    z = max(-1,min(1,z))
    nodes.append([sx, sy, z, random.random()])

# ---------- star field ----------
stars=[(random.uniform(0,W), random.uniform(0,H), random.uniform(0.4,1.6), random.uniform(0.08,0.55)) for _ in range(700)]

# ---------- glow sprite ----------
def make_glow(size, core, halo):
    g=Image.new('L',(size,size),0)
    d=ImageDraw.Draw(g)
    c=size/2
    for r in range(int(c),0,-1):
        t=r/c
        v=(1-t)**2.2*halo + (max(0,(0.35-t)/0.35)**1.6)*core
        d.ellipse([c-r,c-r,c+r,c+r], fill=int(min(255,v*255)))
    return g

sprite = make_glow(96, 0.95, 0.85)
sprite_small = make_glow(64, 0.9, 0.7)

# ---------- draw ----------
img = Image.new('RGB',(W,H),(4,6,12))
d = ImageDraw.Draw(img)
# radial bg
bg = Image.new('RGB',(W,H),(4,6,12))
bd = ImageDraw.Draw(bg)
for i in range(60,0,-1):
    t=i/60
    r=int(420*t)+60
    col=(int(4+10*(1-t)), int(6+16*(1-t)), int(12+30*(1-t)))
    bd.ellipse([CX-r,CY-r*0.8,CX+r,CY+r*0.8], fill=col)
bg = bg.filter(ImageFilter.GaussianBlur(60))
img = bg.copy()
d = ImageDraw.Draw(img)

# stars
for sx,sy,sz,sa in stars:
    v=int(255*sa)
    d.ellipse([sx-sz/2,sy-sz/2,sx+sz/2,sy+sz/2], fill=(v,v,int(v*1.15) if v*1.15<255 else 255))

# links
layer = Image.new('RGB',(W,H),(0,0,0))
ld = ImageDraw.Draw(layer)
for i in range(len(nodes)):
    for j in range(i+1,len(nodes)):
        dx=nodes[i][0]-nodes[j][0]; dy=nodes[i][1]-nodes[j][1]
        dist=math.hypot(dx,dy)
        if dist<95:
            a=int(70*(1-dist/95))
            if a>4:
                ld.line([nodes[i][0],nodes[i][1],nodes[j][0],nodes[j][1]], fill=(a,a,int(a*1.3) if a*1.3<255 else 255), width=1)
layer = layer.filter(ImageFilter.GaussianBlur(0.6))
img = Image.blend(img, Image.new('RGB',(W,H),(0,0,0)), 0)
img = Image.fromarray(np.clip(np.array(img).astype(int)+np.array(layer).astype(int),0,255).astype('uint8'))

# nodes with depth
nodes_sorted = sorted(nodes, key=lambda n:n[2])
glow_acc = Image.new('RGB',(W,H),(0,0,0))
for sx,sy,z,seed in nodes_sorted:
    s = 1.0/(1.0+ (z+1)*0.35)
    bright = 0.30 + 0.70*((z+1)/2)
    size = int(max(10, 46*s))
    sp = sprite if size>24 else sprite_small
    sp2 = sp.resize((size,size), Image.LANCZOS)
    x=sx-size/2; y=sy-size/2
    # tint white-blue
    tint = Image.new('RGB',(size,size),(210,228,255))
    mask = sp2
    glow_acc.paste(tint, (int(x),int(y)), mask.point(lambda v:int(v*bright)))

img = Image.fromarray(np.clip(np.array(img).astype(int)+np.array(glow_acc).astype(int),0,255).astype('uint8'))

# bloom: downscale/upscale
small = img.resize((W//4,H//4), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
bloom = small.resize((W,H), Image.LANCZOS)
img = Image.fromarray(np.clip(np.array(img).astype(int)+ (np.array(bloom).astype(int)*0.75).astype(int),0,255).astype('uint8'))

# one highlighted node (center-ish, strongest)
hot = max(nodes, key=lambda n: 1-abs(n[2]))
d = ImageDraw.Draw(img)
halo=Image.new('RGB',(W,H),(0,0,0)); hd=ImageDraw.Draw(halo)
for k in range(40,0,-1):
    v=int(150*(1-k/40)**2.4)
    hd.ellipse([hot[0]-k,hot[1]-k*0.92,hot[0]+k,hot[1]+k*0.92], fill=(v//3,v,v))
img=Image.fromarray(np.clip(np.array(img).astype(int)+np.array(halo.filter(ImageFilter.GaussianBlur(6))).astype(int),0,255).astype('uint8'))
d=ImageDraw.Draw(img)
d.ellipse([hot[0]-4,hot[1]-4,hot[0]+4,hot[1]+4], fill=(255,255,255))

# labels
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 13)
except Exception:
    font = ImageFont.load_default()
labels=["用户住在杭州","养了一只叫煤球的英短","偏好不加糖的美式","室友小李是夜班护士",
        "每周三晚上打羽毛球","讨厌开会时被打断","正在学 Rust","妈妈生日 3 月 14 日",
        "对花生过敏","通勤 40 分钟","喜欢下雨天","计划明年去日本"]
chosen = random.sample(nodes, min(12,len(nodes)))
for (sx,sy,z,seed),txt in zip(chosen, labels):
    d.text((sx+10, sy-16), txt, font=font, fill=(118,142,178))

img.save(r".refs/mock-starfield-brain.png")
print("ok", len(nodes))
