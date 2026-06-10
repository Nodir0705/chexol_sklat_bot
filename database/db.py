from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select, event, text
from .models import Base, ProductCategory, StockItem
from config import DB_NAME

DATABASE_URL = f"sqlite+aiosqlite:///{DB_NAME}"

engine = create_async_engine(DATABASE_URL, echo=False)

# Enable WAL mode so Python bot and Node server can write concurrently without locking
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Safe column migrations for existing databases
        for sql in [
            "ALTER TABLE users ADD COLUMN username TEXT",
            "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'approved'",
        ]:
            try:
                await conn.execute(text(sql))
            except Exception:
                pass
        # Existing users stay approved; admin is always approved
        from config import ADMIN_ID
        if ADMIN_ID:
            await conn.execute(
                text("UPDATE users SET status='approved' WHERE telegram_id = :id"),
                {"id": ADMIN_ID}
            )
    await seed_initial_data()


async def seed_initial_data():
    """Seeds starter product tree if the table is empty."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(ProductCategory).limit(1))
        if result.scalar_one_or_none():
            return

        # Root categories
        nakitka = ProductCategory(name="Nakitka")
        tarpetka = ProductCategory(name="Tarpetka")
        session.add_all([nakitka, tarpetka])
        await session.flush()

        # Sub-types under Nakitka
        ali = ProductCategory(name="Ali cantara safir", parent_id=nakitka.id)
        cristal = ProductCategory(name="Cristal", parent_id=nakitka.id)
        session.add_all([ali, cristal])
        await session.flush()

        # Leaf models under Ali cantara safir
        qora = ProductCategory(name="Ali cantara safir Qora", parent_id=ali.id)
        seeriy = ProductCategory(name="Ali cantara safir Seeriy", parent_id=ali.id)
        session.add_all([qora, seeriy])
        await session.flush()

        session.add(StockItem(category_id=qora.id, quantity=0))
        session.add(StockItem(category_id=seeriy.id, quantity=0))

        await session.commit()
