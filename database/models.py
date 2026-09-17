from sqlalchemy import (Column, Integer, String, ForeignKey, DateTime, BigInteger,
                        Index, UniqueConstraint)
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

# ─── Warehouse / Sklat models ─────────────────────────────────────────────────

class ProductCategory(Base):
    """Self-referencing tree: Nakitka → Ali cantara safir → Ali cantara safir Qora."""
    __tablename__ = 'product_categories'

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    parent_id = Column(Integer, ForeignKey('product_categories.id'), nullable=True)
    # Fallback unit price in so'm when a client has no client_prices override.
    default_price = Column(Integer, nullable=True)
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


# ─── Client ledger / Mijozlar models ──────────────────────────────────────────

class Client(Base):
    """A person the owner hands goods to on consignment."""
    __tablename__ = 'clients'

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    phone = Column(String, nullable=True)
    # Bound by /ulash run in the client's Telegram group; negative for groups.
    telegram_chat_id = Column(BigInteger, unique=True, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    prices = relationship("ClientPrice", back_populates="client")
    ledger = relationship("ClientLedger", back_populates="client")


class ClientPrice(Base):
    """Per-client unit price override for one product category.

    Price resolution: client_prices -> product_categories.default_price -> error.
    """
    __tablename__ = 'client_prices'
    __table_args__ = (
        UniqueConstraint('client_id', 'category_id', name='uq_client_prices_client_category'),
        Index('ix_client_prices_client_id', 'client_id'),
    )

    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey('clients.id'), nullable=False)
    category_id = Column(Integer, ForeignKey('product_categories.id'), nullable=False)
    unit_price = Column(Integer, nullable=False)  # so'm, > 0

    client = relationship("Client", back_populates="prices")
    category = relationship("ProductCategory")


class ClientLedger(Base):
    """Append-only ledger of everything that moves a client's balance.

    `amount` is signed so'm and is the only field the balance reads:
        SELECT COALESCE(SUM(amount), 0) FROM client_ledger WHERE client_id = ?
    handover -> +qty*unit_price, return -> -qty*unit_price, payment -> -amount,
    adjustment -> either sign. Corrections never update or delete: a mistake is
    cancelled by inserting a reversing row whose reverses_id points at the original.
    """
    __tablename__ = 'client_ledger'
    __table_args__ = (
        Index('ix_client_ledger_client_id_created_at', 'client_id', 'created_at'),
        Index('ix_client_ledger_reverses_id', 'reverses_id'),
        Index('ix_client_ledger_corrects_id', 'corrects_id'),
    )

    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey('clients.id'), nullable=False)
    # 'handover' | 'return' | 'payment' | 'adjustment'
    kind = Column(String, nullable=False)
    category_id = Column(Integer, ForeignKey('product_categories.id'), nullable=True)
    qty = Column(Integer, nullable=True)          # set for handover/return; > 0
    unit_price = Column(Integer, nullable=True)   # price snapshot at the time of the event
    amount = Column(Integer, nullable=False)      # signed so'm
    note = Column(String, nullable=True)
    performed_by = Column(BigInteger, nullable=True)      # Telegram id
    performed_by_name = Column(String, nullable=True)
    reverses_id = Column(Integer, ForeignKey('client_ledger.id'), nullable=True)
    # Set on the re-entry written by an edit, pointing at the row it replaced.
    corrects_id = Column(Integer, ForeignKey('client_ledger.id'), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    client = relationship("Client", back_populates="ledger")
    category = relationship("ProductCategory")
