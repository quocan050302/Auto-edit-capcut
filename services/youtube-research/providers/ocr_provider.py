import io
import re
from typing import List, Optional
from dataclasses import dataclass, field
import numpy as np

try:
    from rapidocr_onnxruntime import RapidOCR
    HAS_RAPID_OCR = True
except ImportError:
    HAS_RAPID_OCR = False
    
from utils.thumbnail_analyzer import NormalizedBox, ThumbnailOcrAnalysis

@dataclass
class OcrTextRegion:
    text: str
    confidence: float
    box: NormalizedBox
    line_index: int
    color_hex: Optional[str] = None
    outline_hex: Optional[str] = None
    font_category: str = "unknown"
    font_weight: str = "unknown"
    alignment: str = "unknown"

class ThumbnailOcrProvider:
    def __init__(self):
        self.ocr = RapidOCR() if HAS_RAPID_OCR else None

    async def analyze(self, image_data: bytes) -> ThumbnailOcrAnalysis:
        if not HAS_RAPID_OCR or not self.ocr:
            return ThumbnailOcrAnalysis(
                text="",
                word_count=0,
                line_count=0,
                confidence=0.0,
                is_uncertain=True,
            )

        try:
            import cv2
            nparr = np.frombuffer(image_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("Failed to decode image for OCR")
            
            h, w = img.shape[:2]
            
            result, _ = self.ocr(img)
            
            if not result:
                return ThumbnailOcrAnalysis(
                    text="",
                    word_count=0,
                    line_count=0,
                    confidence=1.0,
                    is_uncertain=False,
                )
            
            regions = []
            full_text_lines = []
            min_conf = 1.0
            
            total_text_area = 0.0
            
            for idx, item in enumerate(result):
                box = item[0]
                text = item[1]
                conf = item[2]
                
                # box is [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
                x_coords = [p[0] for p in box]
                y_coords = [p[1] for p in box]
                x_min, x_max = min(x_coords), max(x_coords)
                y_min, y_max = min(y_coords), max(y_coords)
                
                box_w = x_max - x_min
                box_h = y_max - y_min
                total_text_area += (box_w * box_h)
                
                n_box = NormalizedBox(
                    x=x_min / w,
                    y=y_min / h,
                    width=box_w / w,
                    height=box_h / h
                )
                
                regions.append(OcrTextRegion(
                    text=text,
                    confidence=conf,
                    box=n_box,
                    line_index=idx
                ))
                full_text_lines.append(text)
                min_conf = min(min_conf, conf)
                
            full_text = "\n".join(full_text_lines)
            words = full_text.split()
            
            has_upper = bool(re.search(r"[A-Z]", full_text))
            upper_ratio = sum(1 for c in full_text if c.isupper()) / max(len(full_text), 1)
            
            # Estimate text coverage
            image_area = w * h
            text_coverage_pct = round(total_text_area / image_area, 3)
            
            # Attach regions dynamically
            res = ThumbnailOcrAnalysis(
                text=full_text,
                word_count=len(words),
                line_count=len(full_text_lines),
                char_count=len(full_text),
                has_uppercase=has_upper,
                uppercase_ratio=round(upper_ratio, 2),
                has_numbers=bool(re.search(r"\d", full_text)),
                has_currency=bool(re.search(r"[$€£¥]", full_text)),
                has_question="?" in full_text,
                has_exclamation="!" in full_text,
                text_coverage_pct=text_coverage_pct,
                confidence=round(min_conf, 2),
                is_uncertain=min_conf < 0.6,
            )
            res.regions = regions
            return res
            
        except Exception as e:
            return ThumbnailOcrAnalysis(
                text="",
                word_count=0,
                line_count=0,
                confidence=0.0,
                is_uncertain=True,
            )
