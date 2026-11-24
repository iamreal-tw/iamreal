# Writes web/test/fixtures/qr-vectors.json: the QR codes another encoder
# (Project Nayuki's qrcodegen, https://www.nayuki.io/page/qr-code-generator-library)
# makes of the texts below, which src/ui/qr.ts must make the same, module for
# module (test/qr.test.ts). Run from the repository's root, with uv
# (qrcodegen is not a dependency of anything here; it is fetched for this run
# only):
#
#   uv run --no-project --with qrcodegen==1.8.0 python web/test/generate/qr-vectors.py
#
# Every code is byte mode, error correction level M, the smallest version
# that holds the text (boostecl off, so the level stays M). For each text,
# the code with the mask qrcodegen chooses, and for two of them the code with
# each of the 8 masks.
#
# src/ui/qr.ts follows qrcodegen's steps, so these codes check that it does so
# without a slip; that a phone reads them was checked with a reader (zbarimg)
# when the encoder was written (#292).
#
# Not segno: segno 1.6.6 adds a whole byte of zeros after the terminator when
# the bits already end on a byte (write_padding_bits in
# https://github.com/heuer/segno/blob/1.6.6/segno/encoder.py: 8 - (length % 8)
# zeros, 8 when length is a multiple of 8), which a reader skips but ISO/IEC
# 18004 (7.4.10) does not write.
import json
import pathlib

from qrcodegen import QrCode, QrSegment

TEXTS = [
    "https://iamreal.tw/hang/7K2Q9FM4XD",
    "https://test.iamreal.tw/hang/7K2Q9FM4XD",
    "A",
    "hello, world",
    "https://iamreal.tw/hang/" + "7K2Q9FM4XD" * 4,
    "w" * 50,
    "x" * 100,
    "v" * 115,
    "0123456789abcdef" * 9,
    "y" * 180,
    "z" * 213,
    "島民證明 iamreal.tw",
]
ALL_MASKS = {"https://iamreal.tw/hang/7K2Q9FM4XD", "x" * 100}


def code(text, mask=-1):
    segment = QrSegment.make_bytes(text.encode("utf-8"))
    qr = QrCode.encode_segments([segment], QrCode.Ecc.MEDIUM, 1, 40, mask, False)
    assert qr.get_error_correction_level() == QrCode.Ecc.MEDIUM, text
    size = qr.get_size()
    rows = ["".join("1" if qr.get_module(x, y) else "0" for x in range(size)) for y in range(size)]
    return {"version": qr.get_version(), "mask": qr.get_mask(), "rows": rows}


vectors = []
for text in TEXTS:
    vectors.append({"text": text, **code(text)})
    if text in ALL_MASKS:
        for mask in range(8):
            vectors.append({"text": text, **code(text, mask), "forced_mask": True})

out = pathlib.Path(__file__).resolve().parent.parent / "fixtures" / "qr-vectors.json"
out.write_text(json.dumps({"generator": "qrcodegen 1.8.0", "vectors": vectors}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {len(vectors)} codes to {out}")
