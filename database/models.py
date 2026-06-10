from sqlalchemy import Column, Integer, String, Boolean, Float, ForeignKey, DateTime, BigInteger, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship, backref
from sqlalchemy.sql import func

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    telegram_id = Column(BigInteger, unique=True, nullable=False)
    name = Column(String)
    username = Column(String, nullable=True)
    language = Column(String, default='uz')
    role = Column(String, default='wife')
    paired_with = Column(BigInteger, nullable=True)
    # 'pending' | 'approved' | 'rejected'
    status = Column(String, default='pending')
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    inventory_items = relationship("Inventory", back_populates="user")
    shopping_list = relationship("ShoppingList", back_populates="user")

class Inventory(Base):
    __tablename__ = 'inventory'
    __table_args__ = (UniqueConstraint('user_id', 'item_name', name='uq_user_item'),)

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, ForeignKey('users.telegram_id'))
    item_name = Column(String, nullable=False)
    item_name_ru = Column(String)
    category = Column(String) # meat, vegetable, grain, dairy, spice, other
    quantity = Column(Float, default=0)
    unit = Column(String) # kg, l, dona, paket
    min_threshold = Column(Float) # alert when below this
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="inventory_items")

class ShoppingList(Base):
    __tablename__ = 'shopping_list'

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, ForeignKey('users.telegram_id'))
    item_name = Column(String, nullable=False)
    quantity = Column(Float)
    unit = Column(String)
    is_bought = Column(Boolean, default=False)
    added_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="shopping_list")

# ─── Warehouse / Sklat models ─────────────────────────────────────────────────

class ProductCategory(Base):
    """Self-referencing tree: Nakitka → Ali cantara safir → Ali cantara safir Qora."""
    __tablename__ = 'product_categories'

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    parent_id = Column(Integer, ForeignKey('product_categories.id'), nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    children = relationship(
        "ProductCategory",
        backref=backref("parent", remote_side="ProductCategory.id"),
        order_by="ProductCategory.name",
    )
    stock = relationship("StockItem", back_populates="category", uselist=False,
                         cascade="all, delete-orphan")
    transactions = relationship("StockTransaction", back_populates="category")


class StockItem(Base):
    """Current quantity for a leaf product category."""
    __tablename__ = 'stock_items'

    id = Column(Integer, primary_key=True)
    category_id = Column(Integer, ForeignKey('product_categories.id'), unique=True, nullable=False)
    quantity = Column(Integer, default=0, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    category = relationship("ProductCategory", back_populates="stock")


class StockTransaction(Base):
    """Immutable log of every stock change. delta>0 = in, delta<0 = out."""
    __tablename__ = 'stock_transactions'

    id = Column(Integer, primary_key=True)
    category_id = Column(Integer, ForeignKey('product_categories.id'), nullable=False)
    delta = Column(Integer, nullable=False)
    performed_by = Column(BigInteger)
    performed_by_name = Column(String)
    action_type = Column(String, default='stock')  # 'stock' | 'delete'
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    category = relationship("ProductCategory", back_populates="transactions")


class ReminderSubscriber(Base):
    """Chat IDs that receive the daily stock reminder."""
    __tablename__ = 'reminder_subscribers'

    id = Column(Integer, primary_key=True)
    chat_id = Column(BigInteger, unique=True, nullable=False)
    added_at = Column(DateTime(timezone=True), server_default=func.now())
