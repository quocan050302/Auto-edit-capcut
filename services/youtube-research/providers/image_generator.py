import httpx
from core.logger import research_logger

class ThumbnailGeneratorProvider:
    def __init__(self, api_key: str = "", provider: str = "disabled"):
        self.api_key = api_key
        self.provider = provider
        
    def update_config(self, api_key: str, provider: str):
        self.api_key = api_key
        self.provider = provider

    async def generate(self, prompt: str, negative_prompt: str = "") -> bytes:
        if self.provider == "disabled" or not self.api_key:
            # Generate a blank placeholder image using PIL if disabled
            from PIL import Image
            import io
            img = Image.new('RGB', (1280, 720), color=(50, 50, 50))
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            return buf.getvalue()
            
        if self.provider == "together":
            # Example using Together AI FLUX or similar
            url = "https://api.together.xyz/v1/images/generations"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": "black-forest-labs/FLUX.1-schnell-Free",
                "prompt": prompt,
                "width": 1280,
                "height": 720,
                "steps": 4,
                "n": 1,
                "response_format": "b64_json"
            }
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    resp = await client.post(url, headers=headers, json=payload)
                    resp.raise_for_status()
                    data = resp.json()
                    import base64
                    b64_data = data["data"][0]["b64_json"]
                    return base64.b64decode(b64_data)
            except Exception as e:
                research_logger.error(f"[ImageGen] Generation failed: {e}")
                
        # Fallback empty image
        from PIL import Image
        import io
        img = Image.new('RGB', (1280, 720), color=(150, 50, 50))
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        return buf.getvalue()
