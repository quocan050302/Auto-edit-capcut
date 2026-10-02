import io
from PIL import Image, ImageDraw, ImageFont

class ThumbnailCompositor:
    def __init__(self):
        pass

    def compose(self, background: bytes, overlay_text: list) -> bytes:
        """
        Composes a thumbnail by pasting overlay text on top of the background.
        background: JPEG/PNG bytes
        overlay_text: List of text strings to render
        """
        try:
            img = Image.open(io.BytesIO(background)).convert("RGBA")
            draw = ImageDraw.Draw(img)
            
            # Try to load a font, fallback to default
            try:
                # Need a truetype font for sizes
                font = ImageFont.truetype("arial.ttf", 80)
            except IOError:
                font = ImageFont.load_default()

            width, height = img.size
            
            # Hardcoded text positioning for now (centered, bottom third)
            if overlay_text:
                full_text = " ".join(overlay_text)
                
                # Use textbbox to center text
                try:
                    bbox = draw.textbbox((0, 0), full_text, font=font)
                    text_w = bbox[2] - bbox[0]
                    text_h = bbox[3] - bbox[1]
                except AttributeError:
                    # Fallback for older PIL
                    text_w, text_h = draw.textsize(full_text, font=font)

                x = (width - text_w) / 2
                y = height * 0.7 - (text_h / 2)
                
                # Draw text shadow / stroke
                stroke_width = 4
                for dx in [-stroke_width, 0, stroke_width]:
                    for dy in [-stroke_width, 0, stroke_width]:
                        draw.text((x + dx, y + dy), full_text, font=font, fill="black")
                
                # Draw main text
                draw.text((x, y), full_text, font=font, fill="white")
                
            out_buf = io.BytesIO()
            img.convert("RGB").save(out_buf, format="JPEG", quality=90)
            return out_buf.getvalue()
        except Exception as e:
            from core.logger import research_logger
            research_logger.error(f"[Compositor] Error compositing thumbnail: {e}")
            return background
