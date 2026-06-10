from pyngrok import ngrok
import time
import os

# Open an HTTPS tunnel to the FastAPI server on port 8000
# Make sure to run `npm run build` in frontend/ first,
# so webapp.py serves the built frontend + API on the same port.
public_url = ngrok.connect(8000).public_url

# Save to .env so bot.py can pick it up
env_path = os.path.join(os.path.dirname(__file__), ".env")
lines = []
if os.path.exists(env_path):
    with open(env_path, "r") as f:
        lines = [l for l in f.readlines() if not l.startswith("WEBAPP_URL=")]
lines.append(f"WEBAPP_URL={public_url}\n")
with open(env_path, "w") as f:
    f.writelines(lines)

print("=" * 50)
print(f"  Public URL: {public_url}")
print()
print("  WEBAPP_URL saved to .env")
print("  Restart bot.py to pick up the new URL.")
print()
print("  Also set in BotFather:")
print("  /mybots -> Bot Settings -> Configure Mini App")
print("=" * 50)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nClosing tunnel...")
    ngrok.kill()
