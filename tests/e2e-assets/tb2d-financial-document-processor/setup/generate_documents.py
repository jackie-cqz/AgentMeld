import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "generated/public/documents"
SPECS = json.loads((ROOT / "setup/document-specs.json").read_text(encoding="utf-8"))
shutil.rmtree(ROOT / "generated", ignore_errors=True)
OUTPUT.mkdir(parents=True)


for spec in SPECS:
    destination = OUTPUT / spec["filename"]
    if spec["kind"] == "image":
        image = Image.new("RGB", (1000, 700), "white")
        draw = ImageDraw.Draw(image)
        y = 70
        for line in spec["lines"]:
            draw.text((70, y), line, fill="black")
            y += 70
        image.save(destination, quality=92)
    else:
        pdf = canvas.Canvas(str(destination), pagesize=(595, 842))
        y = 760
        for line in spec["lines"]:
            pdf.drawString(70, y, line)
            y -= 45
        pdf.save()

print(f"generated {len(SPECS)} synthetic documents in {OUTPUT}")
