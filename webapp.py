import logging
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import uvicorn
from contextlib import asynccontextmanager

from database.db import init_db, AsyncSessionLocal
from database.models import Inventory, ShoppingList, User
from data.items import ITEMS_UZ, ITEM_EMOJIS, ITEM_NAMES_RU, ITEM_UNITS, QUANTITIES
from data.recipes import RECIPES, RECIPE_CATEGORIES
from sqlalchemy import select

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Database initialized (API-only mode, no bot)")
    yield


app = FastAPI(lifespan=lifespan)

# CORS for Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- API Models ---

class StockUpdate(BaseModel):
    user_id: int
    item_name: str
    change: float


class AddItem(BaseModel):
    user_id: int
    item_name: str
    quantity: float
    unit: str
    category: str = "General"


class DeleteItem(BaseModel):
    user_id: int
    item_name: str


class ShareRequest(BaseModel):
    user_id: int


class CookRequest(BaseModel):
    user_id: int
    recipe_id: str
    portions: int = 4


# --- API Routes ---

@app.get("/api/items")
async def get_items():
    """Return item catalog (categories, emojis, quantities) for the frontend."""
    return {
        "categories": ITEMS_UZ,
        "emojis": ITEM_EMOJIS,
        "names_ru": ITEM_NAMES_RU,
        "item_units": ITEM_UNITS,
        "quantities": QUANTITIES,
    }


@app.get("/api/inventory")
async def get_inventory(user_id: int):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(Inventory.user_id == user_id).order_by(Inventory.id)
        )
        items = result.scalars().all()
        return {
            "items": [
                {
                    "id": i.id,
                    "user_id": i.user_id,
                    "item_name": i.item_name,
                    "item_name_ru": i.item_name_ru,
                    "category": i.category,
                    "quantity": i.quantity,
                    "unit": i.unit,
                    "min_threshold": i.min_threshold,
                    "updated_at": str(i.updated_at) if i.updated_at else None,
                }
                for i in items
            ]
        }


@app.post("/api/inventory/add")
async def add_item_api(data: AddItem):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == data.user_id,
                Inventory.item_name == data.item_name,
            )
        )
        item = result.scalar_one_or_none()

        if item:
            item.quantity += data.quantity
            item.unit = data.unit
        else:
            new_item = Inventory(
                user_id=data.user_id,
                item_name=data.item_name,
                quantity=data.quantity,
                unit=data.unit,
                category=data.category,
                min_threshold=2,
            )
            session.add(new_item)
        await session.commit()
    return {"status": "ok"}


@app.post("/api/inventory/update")
async def update_stock(data: StockUpdate):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == data.user_id,
                Inventory.item_name == data.item_name,
            )
        )
        item = result.scalar_one_or_none()
        if item:
            item.quantity += data.change
            if item.quantity < 0:
                item.quantity = 0
            await session.commit()
    return {"status": "ok"}


@app.post("/api/inventory/delete")
async def delete_item_api(data: DeleteItem):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == data.user_id,
                Inventory.item_name == data.item_name,
            )
        )
        item = result.scalar_one_or_none()
        if item:
            await session.delete(item)
            await session.commit()
    return {"status": "ok"}


@app.get("/api/shopping")
async def get_shopping(user_id: int):
    """Return low-stock items as shopping suggestions."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == user_id,
                Inventory.quantity <= 2,
            ).order_by(Inventory.id)
        )
        items = result.scalars().all()
        return {
            "items": [
                {
                    "item_name": i.item_name,
                    "quantity": i.quantity,
                    "unit": i.unit,
                    "needed": (i.min_threshold or 5) - i.quantity,
                    "emoji": ITEM_EMOJIS.get(i.item_name, ""),
                }
                for i in items
            ]
        }


@app.post("/api/shopping/share")
async def share_shopping(data: ShareRequest):
    """Build shopping list text. In production, this would send via bot to partner."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(
                Inventory.user_id == data.user_id,
                Inventory.quantity <= 2,
            )
        )
        items = result.scalars().all()
        lines = [f"{ITEM_EMOJIS.get(i.item_name, '')} {i.item_name} — {i.quantity} {i.unit}" for i in items]
        text = "🛒 Xarid ro'yxati:\n" + "\n".join(lines) if lines else "Hammasi yetarli!"
    return {"status": "ok", "text": text}


# --- Recipe Routes ---

@app.get("/api/recipes")
async def get_recipes():
    """Return all recipes and category metadata."""
    return {
        "recipes": RECIPES,
        "categories": RECIPE_CATEGORIES,
    }


@app.get("/api/recipes/available")
async def get_available_recipes(user_id: int):
    """Return recipes filtered by what the user can cook with current inventory."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Inventory).where(Inventory.user_id == user_id)
        )
        inv_items = result.scalars().all()
        stock = {i.item_name: i.quantity for i in inv_items}

    available = []
    for recipe in RECIPES:
        total = len(recipe["ingredients"])
        have = 0
        missing = []
        for ing in recipe["ingredients"]:
            item_name = ing["item"]
            needed = ing["qty"]
            in_stock = stock.get(item_name, 0)
            if in_stock >= needed:
                have += 1
            else:
                missing.append({
                    "item": item_name,
                    "needed": needed,
                    "have": in_stock,
                    "unit": ing["unit"],
                })
        available.append({
            **recipe,
            "match_count": have,
            "match_total": total,
            "match_pct": round(have / total * 100) if total else 0,
            "missing": missing,
        })

    # Sort by match percentage descending
    available.sort(key=lambda r: r["match_pct"], reverse=True)
    return {"recipes": available}


@app.post("/api/recipes/cook")
async def cook_recipe(data: CookRequest):
    """Deduct recipe ingredients from inventory based on portion scaling."""
    recipe = next((r for r in RECIPES if r["id"] == data.recipe_id), None)
    if not recipe:
        return {"status": "error", "message": "Recipe not found"}

    scale = data.portions / recipe["base_portions"]

    async with AsyncSessionLocal() as session:
        for ing in recipe["ingredients"]:
            result = await session.execute(
                select(Inventory).where(
                    Inventory.user_id == data.user_id,
                    Inventory.item_name == ing["item"],
                )
            )
            item = result.scalar_one_or_none()
            if item:
                item.quantity -= ing["qty"] * scale
                if item.quantity < 0:
                    item.quantity = 0
        await session.commit()

    return {"status": "ok"}


# --- Serve frontend in production ---
DIST_DIR = os.path.join(os.path.dirname(__file__), "frontend", "dist")
if os.path.isdir(DIST_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the React SPA for all non-API routes."""
        file_path = os.path.join(DIST_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))


if __name__ == "__main__":
    uvicorn.run("webapp:app", host="0.0.0.0", port=8000, reload=True)
