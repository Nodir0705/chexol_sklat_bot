import os
import requests

# Twemoji CDN base URL
BASE_URL = "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/"

# Mapping: Item Name -> Unicode Hex Code
ICON_MAP = {
    "Kartoshka": "1f954",       # 🥔
    "Piyoz": "1f9c5",           # 🧅
    "Sabzi": "1f955",           # 🥕
    "Pomidor": "1f345",         # 🍅
    "Bodring": "1f952",         # 🥒
    "Karam": "1f96c",           # 🥬
    "Sarimsoq": "1f9c4",        # 🧄
    "Baqlajon": "1f346",        # 🍆
    "Oshqovoq": "1f383",        # 🎃
    "Olma": "1f34e",            # 🍎
    "Uzum": "1f347",            # 🍇
    "Nok": "1f350",             # 🍐
    "Banan": "1f34c",           # 🍌
    "Mol go'shti": "1f969",     # 🥩
    "Tovuq": "1f357",           # 🍗
    "Tuxum": "1f95a",           # 🥚
    "Baliq": "1f41f",           # 🐟
    "Sut": "1f95b",             # 🥛
    "Pishloq": "1f9c0",         # 🧀
    "Non": "1f35e",             # 🍞
    "Un": "1f33e",              # 🌾 (Ear of Rice/Wheat)
    "Guruch": "1f35a",          # 🍚
    "Makaron": "1f35d",         # 🍝
    "O'simlik yog'i": "1f9fa",  # fa (Jar) or Sunflower 1f33b
    "Tuz": "1f9c2",             # 🧂
    "Shakar": "1f36c",          # 🍬
    "Choy": "1f375",            # 🍵
    "default": "1f4e6"          # 📦 Package
}

SAVE_DIR = "uybeka_bot/data/icons"

def download_icons():
    # Force absolute path
    abs_save_dir = os.path.abspath(SAVE_DIR)
    if not os.path.exists(abs_save_dir):
        os.makedirs(abs_save_dir)
        
    print(f"Downloading icons to {abs_save_dir}...")
    
    for name, code in ICON_MAP.items():
        url = f"{BASE_URL}{code}.png"
        save_path = os.path.join(abs_save_dir, f"{name}.png")
        
        # Force download always
        # if os.path.exists(save_path):
        #    continue
            
        try:
            print(f"Fetching {url}...")
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                with open(save_path, 'wb') as f:
                    f.write(r.content)
                print(f"✅ Downloaded: {name} ({len(r.content)} bytes)")
            else:
                print(f"❌ Failed to download {name}: {r.status_code}")
        except Exception as e:
            print(f"⚠️ Error downloading {name}: {e}")

if __name__ == "__main__":
    download_icons()
