"""Emit small reproducible hashes from actual Pillow, not a JS self-reference.

No photos, network, file reads/writes or model inference. RGB bytes are synthetic.
Usage: py -3.12 scripts/reference-disturbing-preprocessing.py
"""
import hashlib
import json
import struct
from PIL import Image, __version__


CASES = [(1, 1, 1), (1, 9, 2), (9, 1, 3), (17, 13, 4), (224, 224, 5),
         (223, 225, 6), (225, 223, 7), (449, 17, 8), (17, 449, 9),
         (321, 517, 10), (640, 480, 11), (2001, 1, 12), (1, 2001, 13),
         (2048, 1024, 14)]


def rgb_bytes(width, height, seed):
    state = seed
    result = bytearray(width * height * 3)
    for index in range(len(result)):
        state = (state * 1664525 + 1013904223) & 0xffffffff
        result[index] = state >> 24
    return bytes(result)


records = []
for width, height, seed in CASES:
    image = Image.frombytes("RGB", (width, height), rgb_bytes(width, height, seed))
    resized = image.resize((224, 224), Image.Resampling.BILINEAR).tobytes()
    nchw = b"".join(struct.pack("<f", resized[pixel * 3 + channel])
                    for channel in range(3) for pixel in range(224 * 224))
    records.append(dict(width=width, height=height, seed=seed,
                        rgb_sha256=hashlib.sha256(resized).hexdigest(),
                        nchw_sha256=hashlib.sha256(nchw).hexdigest()))
print(json.dumps(dict(reference="Pillow", version=__version__, cases=records)))
