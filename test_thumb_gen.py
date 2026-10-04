import httpx
import asyncio
import json

async def test_gen():
    url = "http://localhost:8765/api/research/competitor/thumbnail-generate"
    payload = {
        "title": "Testing my Thumbnail Generator",
        "blueprint": {
            "id": "bp1",
            "name": "Test Blueprint",
            "description": "desc",
            "use_when": "always",
            "target_hook": "curiosity",
            "background_recipe": "dark mysterious background",
            "subject_recipe": "surprised man",
            "lighting_recipe": "high contrast",
            "overlay_text_formula": ["TESTING"],
            "image_prompt_template": "dark mysterious background, surprised man, high contrast"
        }
    }
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, json=payload)
        print("Status:", resp.status_code)
        if resp.status_code == 200:
            data = resp.json()
            print("Prompt used:", data.get("prompt_used"))
            img_b64 = data.get("image_base64")
            print("Base64 length:", len(img_b64) if img_b64 else 0)
            if img_b64:
                import base64
                with open("test_out.jpg", "wb") as f:
                    f.write(base64.b64decode(img_b64))
                print("Saved image to test_out.jpg")
        else:
            print("Error:", resp.text)

if __name__ == "__main__":
    asyncio.run(test_gen())
