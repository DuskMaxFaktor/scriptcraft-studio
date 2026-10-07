"""Generates app.ico (the ScriptCraftStudio.exe / tray icon). Requires Pillow: pip install pillow"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024  # draw large, then downscale for smooth edges


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon() -> Image.Image:
    # Diagonal indigo gradient
    top, bottom = (99, 102, 241), (67, 56, 202)
    grad = Image.new('RGB', (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = lerp(top, bottom, (x + y) / (2 * S - 2))

    # Rounded-square mask
    mask = Image.new('L', (S, S), 0)
    m = S * 2 // 64
    ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], radius=S * 14 // 64, fill=255)

    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # ">_" terminal glyph
    d = ImageDraw.Draw(img)
    u = S / 64
    w = round(6 * u)
    chevron = [(17 * u, 22 * u), (29 * u, 32 * u), (17 * u, 42 * u)]
    d.line(chevron, fill=(255, 255, 255, 255), width=w, joint='curve')
    for x, y in (chevron[0], chevron[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=(255, 255, 255, 255))
    d.line([(33 * u, 43 * u), (47 * u, 43 * u)], fill=(165, 243, 252, 255), width=w)
    for x in (33 * u, 47 * u):
        d.ellipse([x - w / 2, 43 * u - w / 2, x + w / 2, 43 * u + w / 2], fill=(165, 243, 252, 255))
    return img


if __name__ == '__main__':
    out = Path(__file__).with_name('app.ico')
    big = make_icon().resize((256, 256), Image.LANCZOS)
    big.save(out, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f'Saved {out}')
