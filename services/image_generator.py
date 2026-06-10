from PIL import Image, ImageDraw, ImageFont
import os

# Font path - using a standard system font found in the check
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REGULAR_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def get_font(size, bold=False):
    path = FONT_PATH if bold else REGULAR_FONT_PATH
    try:
        return ImageFont.truetype(path, size)
    except IOError:
        return ImageFont.load_default()

from data.items import ITEM_EMOJIS
import random

def generate_inventory_image(items, user_name="Beka"):
    """Generates a visual dashboard of the inventory (Wire Basket + Stacked Items)."""
    
    # Grid settings
    cols = 2
    padding = 30
    card_gap = 40
    card_width = 340
    card_height = 200
    header_height = 120
    
    # Calculate canvas size
    import math
    rows = math.ceil(len(items) / cols)
    width = (card_width * cols) + (padding * 2) + card_gap
    height = header_height + (rows * (card_height + card_gap)) + padding
    
    # Colors
    bg_color = '#F0F2F5'        # Light Grey BG
    wire_color = '#37474F'      # Dark Grey/Black for wire
    tag_bg = '#FFFFFF'          # White tag
    header_bg = '#37474F'       # Dark Header
    
    # Create image
    img = Image.new('RGB', (width, height), color=bg_color)
    draw = ImageDraw.Draw(img)
    
    # Fonts
    font_header = get_font(44, bold=True)
    font_tag = get_font(28, bold=True)
    font_qty = get_font(56, bold=True)
    font_unit = get_font(24)
    font_emoji = get_font(64) # Big font for emoji items
    
    # Draw Header
    draw.rectangle([(0, 0), (width, header_height)], fill=header_bg)
    header_text = f"🏠 {user_name}ning Oshxonasi"
    draw.text((padding + 10, 35), header_text, font=font_header, fill='white')
    
    # Draw Items Grid
    start_y = header_height + padding
    
    for i, item in enumerate(items):
        row = i // cols
        col = i % cols
        
        x = padding + (col * (card_width + card_gap))
        y = start_y + (row * (card_height + card_gap))
        
        # Determine wire color based on stock (optional, or keep black)
        # Let's keep black wire but maybe a small colored tag indicator
        qty = item.quantity
        if qty > 3:
            rim_color = '#66BB6A'    # Green
        elif qty > 0:
            rim_color = '#FBC02D'    # Yellow
        else:
            rim_color = '#EF5350'    # Red
            
        # --- DRAW ITEM STACK (Behind the front wires) ---
        # Get Emoji
        emoji = ITEM_EMOJIS.get(item.item_name, "📦") # Default box if not found
        
        # How many to draw? (Visual representation, capped at ~6 for space)
        # e.g. 5kg -> 5 items
        count = int(min(qty if qty > 0 else 0, 6))
        if count == 0 and qty > 0: count = 1 # Show at least 1 if < 1kg
        
        # Random seed for consistency per item
        random.seed(item.item_name) 
        
        # Draw emojis "inside" the basket area
        basket_bottom = y + card_height - 10
        basket_left = x + 30
        basket_right = x + card_width - 30
        
        # Stack logic: pile them up from bottom
        for j in range(count):
            # Random position within basket bounds
            ex = random.randint(basket_left, basket_right - 60)
            ey = random.randint(int(basket_bottom - 100), int(basket_bottom - 60))
            # Slightly offset each one so they overlap naturally
            draw.text((ex, ey), emoji, font=font_emoji, embedded_color=True)

        # --- DRAW BASKET (Wireframe) ---
        
        # Coordinates for trapezoid basket
        tl = (x, y)
        tr = (x + card_width, y)
        br = (x + card_width - 30, y + card_height)
        bl = (x + 30, y + card_height)
        
        # 1. Draw Wire Frame (Thick Outline)
        draw.line([tl, tr, br, bl, tl], fill=wire_color, width=5)
        
        # 2. Draw Vertical Wires
        num_wires = 6
        step = card_width / (num_wires + 1)
        for w in range(1, num_wires + 1):
            wx_top = x + (step * w)
            wx_bottom = x + 30 + ((card_width - 60) / (num_wires + 1) * w)
            draw.line([(wx_top, y), (wx_bottom, y + card_height)], fill=wire_color, width=2)
            
        # 3. Draw Horizontal Wires
        num_h_wires = 3
        h_step = card_height / (num_h_wires + 1)
        for h in range(1, num_h_wires + 1):
            hy = y + (h_step * h)
            hx_left = x + (30 * (h / (num_h_wires + 1)))
            hx_right = x + card_width - (30 * (h / (num_h_wires + 1)))
            draw.line([(hx_left, hy), (hx_right, hy)], fill=wire_color, width=2)

        # --- DRAW LABEL TAG ---
        tag_w = 200
        tag_h = 50
        tag_x = x + (card_width - tag_w) / 2
        tag_y = y + 20
        
        # Tag shadow
        draw.rounded_rectangle([(tag_x+2, tag_y+2), (tag_x + tag_w+2, tag_y + tag_h+2)], radius=5, fill='#BDBDBD')
        # Tag body
        draw.rounded_rectangle([(tag_x, tag_y), (tag_x + tag_w, tag_y + tag_h)], radius=5, fill=tag_bg, outline=wire_color, width=2)
        
        # Indicator strip on tag
        draw.rectangle([(tag_x, tag_y), (tag_x + 10, tag_y + tag_h)], fill=rim_color)
        
        # Item Name
        name_text = item.item_name.capitalize()
        name_w = draw.textlength(name_text, font=font_tag)
        name_start = tag_x + (tag_w - name_w) / 2
        draw.text((name_start, tag_y + 8), name_text, font=font_tag, fill=wire_color)
        
        # --- DRAW QUANTITY OVERLAY ---
        # A small badge or overlay for the exact number
        qty_text = f"{qty}"
        unit_text = f"{item.unit}"
        
        # Draw a semi-transparent bubble for readability
        center_x = x + card_width / 2
        center_y = y + 110
        
        # Draw Quantity
        qty_w = draw.textlength(qty_text, font=font_qty)
        # White outline for text to make it pop against the wires/emojis
        draw.text((center_x - qty_w/2, center_y), qty_text, font=font_qty, fill=wire_color, stroke_width=3, stroke_fill='white')
        
        # Draw Unit
        unit_w = draw.textlength(unit_text, font=font_unit)
        draw.text((center_x - unit_w/2, center_y + 60), unit_text, font=font_unit, fill='#546E7A', stroke_width=2, stroke_fill='white')

    # Save logic
    output_dir = "uybeka_bot/data"
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    safe_name = "".join([c for c in user_name if c.isalnum() or c in (' ', '.', '_')]).strip()
    if not safe_name:
        safe_name = "user"
        
    output_path = os.path.join(output_dir, f"inventory_{safe_name}.png")
    img.save(output_path)
    return output_path
