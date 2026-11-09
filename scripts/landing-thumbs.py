# Landing-page thumbnails (public/landing/<id>.webp).
#
# Run from the repo root: python3 scripts/landing-thumbs.py
#
# i.ytimg hqdefault is 480x360 with the frame letterboxed inside it, so after
# cropping to the card's 4:5 there were ~200 real pixels left and the landing
# looked blurry. maxresdefault carries the creator's own cover: full 16:9 for
# a horizontal thumbnail, or the vertical cover (405x720) pillarboxed on a
# blurred copy of itself. (oar2 is higher resolution but it is an automatic
# frame from the video, not the cover - the text on the thumbnails is gone.)
# Each is cropped to 4:5 around a hand-picked focus point and saved at 480x600.
import io, urllib.request
from PIL import Image
# id -> (vertical Short?, fx, fy). Vertical Shorts come back as their custom
# thumbnail pillarboxed inside a 1280x720 maxres (405x720 in the middle).
ITEMS = {
  'nYpN1D06LrM': (False, .5, .15), 'qvFEJ5ksTZc': (False, .5, .15), 'dn627jC3Kf0': (False, .5, .2),
  'pz3UTWk4R-o': (False, .5, .25), 'woGWeN2vsuY': (False, .5, .4), 'nGPFYc6eTKw': (False, .5, .3),
  '1d4WkrDhKfg': (False, .5, .25), 'PTd98UnJnnU': (False, .5, .3),
}
out_dir = 'public/landing'
sheet = Image.new('RGB', (240*len(ITEMS), 300))
for i, (v, (vertical, fx, fy)) in enumerate(ITEMS.items()):
    # oar2 is a full vertical frame: for someone on camera the face is the cover.
    im = Image.open(io.BytesIO(urllib.request.urlopen(f'https://i.ytimg.com/vi/{v}/oar2.jpg').read())).convert('RGB')
    w, h = im.size
    if vertical:
        cw = round(h * 9 / 16) - 12; l0 = (w - cw) // 2  # 6px inset: the blurred pillarbox bleeds into the edge
        im = im.crop((l0, 0, l0 + cw, h)); w, h = im.size
    if w / h > 0.8: ch, cw = h, int(h * 0.8)
    else: cw, ch = w, int(w / 0.8)
    l = int(round((w - cw) * fx)); t = int(round((h - ch) * fy))
    crop = im.crop((l, t, l + cw, t + ch)).resize((480, 600), Image.LANCZOS)
    crop.save(f'{out_dir}/{v}.webp', 'WEBP', quality=86, method=6)
    sheet.paste(crop.resize((240, 300)), (i*240, 0))
    print(v, (cw, ch))
sheet.save('/tmp/landing-thumbs-sheet.jpg')  # a contact sheet to eyeball the crops
