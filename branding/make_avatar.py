#!/usr/bin/env python3
"""
Avatar WhatsApp — David Duque · Cirugía Plástica
Filosofía: Reposo Quirúrgico.
Paleta exacta de davidduque.com:
  petróleo  #1E4A5C   dorado #C9B86B   crema #FBF8F2
Render 1280px (2x) → export 640x640 (formato WhatsApp).
Diseñado para recorte CIRCULAR: todo lo importante dentro del círculo seguro.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math

S = 1280                      # lienzo 2x
CX = CY = S // 2
FONT = "C:/Users/dfduq/bukeala-bot/branding/"

PETROLEO   = (30, 74, 92)
PETRO_DARK = (18, 50, 64)
PETRO_DEEP = (12, 38, 50)
DORADO     = (201, 184, 107)
DORADO_SOFT= (176, 160, 96)
CREMA      = (251, 248, 242)
CREMA_DIM  = (228, 222, 208)

img = Image.new("RGB", (S, S), PETROLEO)
d = ImageDraw.Draw(img)

# ---------- 1. Fondo: degradado radial petróleo (centro claro → bordes profundos)
# construido por anillos para suavidad
grad = Image.new("RGB", (S, S), PETRO_DEEP)
gd = ImageDraw.Draw(grad)
maxr = int(S * 0.72)
for i in range(maxr, 0, -1):
    t = i / maxr                      # 1 borde, 0 centro
    # interpola PETROLEO(centro) -> PETRO_DEEP(borde)
    r = int(PETROLEO[0]*(1-t) + PETRO_DEEP[0]*t)
    g = int(PETROLEO[1]*(1-t) + PETRO_DEEP[1]*t)
    b = int(PETROLEO[2]*(1-t) + PETRO_DEEP[2]*t)
    gd.ellipse([CX-i, CY-i, CX+i, CY+i], fill=(r, g, b))
img = grad
d = ImageDraw.Draw(img)

# ---------- 2. Anillo dorado fino (notación clínica, perímetro)
def ring(draw, cx, cy, rad, color, width):
    draw.ellipse([cx-rad, cy-rad, cx+rad, cy+rad], outline=color, width=width)

R_OUT = int(S*0.430)
ring(d, CX, CY, R_OUT, DORADO_SOFT, 3)
ring(d, CX, CY, R_OUT-14, (*PETROLEO,), 0)  # respiro
# segundo anillo interior, más tenue
ring(d, CX, CY, int(S*0.398), (60, 104, 122), 2)

# ---------- 3. Marcas de notación: pequeños ticks dorados en eje vertical/horizontal
def tick(cx, cy, ang_deg, r0, r1, color, w):
    a = math.radians(ang_deg)
    x0 = cx + r0*math.cos(a); y0 = cy + r0*math.sin(a)
    x1 = cx + r1*math.cos(a); y1 = cy + r1*math.sin(a)
    d.line([x0, y0, x1, y1], fill=color, width=w)

for ang in (90, 270):  # arriba y abajo
    tick(CX, CY, ang, R_OUT-30, R_OUT-10, DORADO_SOFT, 3)

# ---------- 4. Monograma DD (Gloock, alto contraste serif)
mono_font = ImageFont.truetype(FONT+"Gloock-Regular.ttf", 430)
mono = "DD"
# medir
bb = d.textbbox((0,0), mono, font=mono_font)
mw = bb[2]-bb[0]; mh = bb[3]-bb[1]
mx = CX - mw/2 - bb[0]
my = CY - mh/2 - bb[1] - int(S*0.115)   # subir para dejar sitio amplio al texto inferior

# sombra sutil para profundidad (no dura)
shadow = Image.new("RGBA", (S, S), (0,0,0,0))
sd = ImageDraw.Draw(shadow)
sd.text((mx+6, my+8), mono, font=mono_font, fill=(0,0,0,70))
shadow = shadow.filter(ImageFilter.GaussianBlur(10))
img.paste(Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB"), (0,0))
d = ImageDraw.Draw(img)

# las dos D: la primera crema, ligero traslape elegante con segunda en dorado
# para lograr traslape, dibujo D + D manualmente con kerning negativo
d_font = mono_font
dchar = "D"
dbb = d.textbbox((0,0), dchar, font=d_font)
dw = dbb[2]-dbb[0]
overlap = int(dw*0.26)
total_w = dw*2 - overlap
startx = CX - total_w/2 - dbb[0]
# segunda D (atrás) en dorado
d.text((startx + dw - overlap, my), dchar, font=d_font, fill=DORADO)
# primera D (frente) en crema
d.text((startx, my), dchar, font=d_font, fill=CREMA)

# ---------- 5. Línea divisoria + rombo dorado (firma de la marca, igual que la web)
div_y = my + mh + int(S*0.075)
seg = int(S*0.090)
gap = int(S*0.028)
lw = 3
# líneas
d.line([CX-gap-seg, div_y, CX-gap, div_y], fill=DORADO_SOFT, width=lw)
d.line([CX+gap, div_y, CX+gap+seg, div_y], fill=DORADO_SOFT, width=lw)
# rombo central
rs = 9
d.polygon([(CX, div_y-rs), (CX+rs, div_y), (CX, div_y+rs), (CX-rs, div_y)], fill=DORADO)

# ---------- 6. Texto: nombre + especialidad (susurro, mayúsculas espaciadas)
def spaced(txt, n=1):
    return (" "*n).join(list(txt))

name_font = ImageFont.truetype(FONT+"Italiana-Regular.ttf", 92)
spec_font = ImageFont.truetype(FONT+"InstrumentSans-Regular.ttf", 38)

name = "DAVID DUQUE"
nb = d.textbbox((0,0), name, font=name_font)
nw = nb[2]-nb[0]
ny = div_y + int(S*0.030)
d.text((CX - nw/2 - nb[0], ny), name, font=name_font, fill=CREMA)

spec = spaced("CIRUGÍA PLÁSTICA", 2)
sb = d.textbbox((0,0), spec, font=spec_font)
sw = sb[2]-sb[0]
sy = ny + (nb[3]-nb[1]) + int(S*0.030)
d.text((CX - sw/2 - sb[0], sy), spec, font=spec_font, fill=DORADO_SOFT)

# ---------- 7. export
img_final = img.resize((640, 640), Image.LANCZOS)
img_final.save("C:/Users/dfduq/bukeala-bot/branding/avatar_wa.png", "PNG")
# también versión grande por si se quiere imprimir / otros usos
img.save("C:/Users/dfduq/bukeala-bot/branding/avatar_wa_2x.png", "PNG")
print("OK avatar_wa.png (640x640) + avatar_wa_2x.png (1280x1280)")
