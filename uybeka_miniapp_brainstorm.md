# 🍲 UyBeka — Telegram Mini App for Uzbek Family Kitchen Management

> **Tagline**: "Oshxonangiz yordamchisi" (Your kitchen assistant)

---

## 📋 Executive Summary

A **Telegram Mini App** helping Uzbek housewives manage groceries, plan meals, and coordinate shopping with husbands — with a beautiful native-like interface right inside Telegram.

**Why Mini App over Bot Commands?**
| Aspect | Traditional Bot | Mini App ✅ |
|--------|-----------------|-------------|
| Interface | Text commands only | Full HTML/CSS/JS UI |
| UX | Clunky, learning curve | Native-like, intuitive |
| Data entry | Type everything | Tap, swipe, forms |
| Visuals | Limited (images) | Real-time charts, animations |
| Offline | Not possible | DeviceStorage (5MB local) |
| Home screen | No | Yes, direct shortcut |

---

## 🎯 Problem Validation

### Why This Matters

| Problem | Pain Level | Current Solution |
|---------|------------|------------------|
| "What should I cook today?" | 🔥🔥🔥 High | Mental load, repetition |
| Running out of staples (oil, flour, rice) | 🔥🔥🔥 High | Last-minute store runs |
| Husband buys wrong items | 🔥🔥 Medium | Phone calls, arguments |
| Cooking for varying family sizes | 🔥🔥 Medium | Guesswork |
| Unbalanced meals (too much carbs) | 🔥 Low | Ignored |

### Why Telegram Mini App?

- **Uzbekistan Context**: Telegram is #1 (80%+ penetration)
- No separate app install — runs inside Telegram
- Works on low-end phones (just a webview)
- Native feel with Telegram theme integration
- **CloudStorage**: 1024 items per user stored in Telegram
- **DeviceStorage**: 5MB local storage for offline use
- Can be added to home screen for quick access
- Husband can access same Mini App — shared shopping list!

### Target User Persona

**Primary: "Dilnoza"** — 32 years old
- Married, 2 kids, lives with mother-in-law
- Cooks 2-3 times daily
- Smartphone but limited storage (won't install another app)
- Wants visual, easy-to-use interface

**Secondary: "Aziz"** (Husband) — 35 years old
- Gets shopping list notification
- Opens same Mini App, sees clear list
- Taps items as he buys them

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        TELEGRAM CLIENT                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    MINI APP (WebView)                     │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │              React/Vue Frontend                     │  │  │
│  │  │  • Inventory Dashboard                              │  │  │
│  │  │  • Recipe Browser                                   │  │  │
│  │  │  • Shopping List                                    │  │  │
│  │  │  • Settings                                         │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                         │                                  │  │
│  │            ┌────────────┴────────────┐                    │  │
│  │            ▼                         ▼                    │  │
│  │    ┌──────────────┐          ┌──────────────┐             │  │
│  │    │ CloudStorage │          │ DeviceStorage│             │  │
│  │    │ (1024 items) │          │  (5MB local) │             │  │
│  │    │ Synced data  │          │ Offline cache│             │  │
│  │    └──────────────┘          └──────────────┘             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│                    ┌──────────────────┐                         │
│                    │   Bot Backend    │                         │
│                    │ (Python/FastAPI) │                         │
│                    │ • Notifications  │                         │
│                    │ • Shared lists   │                         │
│                    │ • Recipe DB      │                         │
│                    └──────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### Data Storage Strategy

| Data Type | Storage | Why |
|-----------|---------|-----|
| User inventory | CloudStorage | Synced across devices |
| Shopping list | CloudStorage | Shared with husband |
| Recipes (cache) | DeviceStorage | Fast offline access |
| User preferences | CloudStorage | Persist settings |
| UI state | DeviceStorage | Quick resume |

---

## 🏗️ Feature Roadmap (Phased)

### Phase 1: MVP — "Smart Pantry" (Week 1-2)

Beautiful inventory management with visual stock levels.

**Screens:**
```
1. 🏠 Home Dashboard
   • Visual stock levels (progress bars)
   • Low stock alerts (red indicators)
   • Quick actions: Add item, View shopping list

2. 📦 Inventory
   • Categorized items (go'sht, sabzavot, don, etc.)
   • Swipe to adjust quantity
   • Tap to edit details
   • Search/filter

3. 🛒 Shopping List
   • Auto-generated from low stock
   • Manual add items
   • Share button → sends to husband via bot message
   • Checkboxes for "bought" status
```

**Features:**
```
✅ Add/edit/remove grocery items
✅ Visual stock level bars (color-coded)
✅ Categories with icons
✅ Low stock threshold alerts
✅ Generate shopping list
✅ Share list via Telegram message
✅ Uzbek/Russian language toggle
✅ Theme sync with Telegram (light/dark)
```

### Phase 2: Recipe Integration (Week 3-4)

```
4. 🍲 Recipe Browser
   • Browse by category
   • "What can I cook?" — filters by available ingredients
   • Recipe cards with images
   • Tap to view full recipe

5. 📖 Recipe Detail
   • Ingredients with availability indicator (✅/❌)
   • Portion scaler (2-4-6-8 people)
   • Step-by-step instructions
   • "Cook this" button → deducts ingredients

✅ 30+ traditional Uzbek recipes
✅ Ingredient matching with inventory
✅ Recipe scaling
✅ Auto-deduct ingredients when cooking
```

### Phase 3: Family Sync (Week 5-6)

```
✅ Husband pairing (shared CloudStorage namespace)
✅ Real-time shopping list sync
✅ Push notifications for husband
✅ "Item bought" updates instantly
✅ Purchase history
```

### Phase 4: Smart Features (Week 7-8)

```
✅ Health nudges ("3 kun go'sht yedingiz...")
✅ Weekly meal balance report
✅ Visual analytics dashboard
✅ Add to home screen prompt
✅ Offline mode with DeviceStorage
```

### Phase 5: Future

```
⬜ Voice input (speech-to-text)
⬜ Receipt scanning (photo → items)
⬜ Bazaar price tracking
⬜ Meal calendar
⬜ Family meal preferences
```

---

## 💻 Tech Stack

### Frontend (Mini App)

```
Framework:      React 18 + TypeScript
Styling:        Tailwind CSS (mobile-first)
State:          Zustand (lightweight)
Build:          Vite
Telegram SDK:   @twa-dev/sdk (TypeScript wrapper)
```

### Backend

```
Language:       Python 3.11+
Framework:      FastAPI
Database:       PostgreSQL (recipes, shared data)
Bot Library:    python-telegram-bot (async)
Hosting:        Railway / Render / VPS
```

### Why This Stack?

- **React**: Component reusability, great ecosystem
- **Tailwind**: Rapid UI development, small bundle
- **FastAPI**: Fast, async, auto-docs
- **PostgreSQL**: Recipes need relational queries

---

## 📁 Project Structure

```
uybeka/
├── frontend/                    # Mini App (React)
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── main.tsx            # Entry point
│   │   ├── App.tsx             # Root component
│   │   ├── components/
│   │   │   ├── ui/             # Reusable UI components
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Card.tsx
│   │   │   │   ├── ProgressBar.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   └── BottomSheet.tsx
│   │   │   ├── inventory/
│   │   │   │   ├── InventoryList.tsx
│   │   │   │   ├── InventoryItem.tsx
│   │   │   │   ├── AddItemForm.tsx
│   │   │   │   └── CategoryTabs.tsx
│   │   │   ├── shopping/
│   │   │   │   ├── ShoppingList.tsx
│   │   │   │   └── ShoppingItem.tsx
│   │   │   ├── recipes/
│   │   │   │   ├── RecipeList.tsx
│   │   │   │   ├── RecipeCard.tsx
│   │   │   │   ├── RecipeDetail.tsx
│   │   │   │   └── PortionScaler.tsx
│   │   │   └── dashboard/
│   │   │       ├── Dashboard.tsx
│   │   │       ├── StockOverview.tsx
│   │   │       └── QuickActions.tsx
│   │   ├── pages/
│   │   │   ├── HomePage.tsx
│   │   │   ├── InventoryPage.tsx
│   │   │   ├── ShoppingPage.tsx
│   │   │   ├── RecipesPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── hooks/
│   │   │   ├── useTelegram.ts      # Telegram WebApp SDK
│   │   │   ├── useCloudStorage.ts  # CloudStorage wrapper
│   │   │   ├── useDeviceStorage.ts # DeviceStorage wrapper
│   │   │   └── useInventory.ts     # Inventory logic
│   │   ├── store/
│   │   │   ├── inventoryStore.ts
│   │   │   ├── shoppingStore.ts
│   │   │   └── settingsStore.ts
│   │   ├── services/
│   │   │   ├── storage.ts          # Storage abstraction
│   │   │   ├── api.ts              # Backend API calls
│   │   │   └── telegram.ts         # Telegram SDK helpers
│   │   ├── utils/
│   │   │   ├── i18n.ts             # Translations
│   │   │   └── helpers.ts
│   │   ├── types/
│   │   │   └── index.ts
│   │   ├── data/
│   │   │   ├── categories.ts       # Item categories
│   │   │   ├── units.ts            # Measurement units
│   │   │   └── recipes.ts          # Recipe data (MVP)
│   │   └── styles/
│   │       └── globals.css
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.json
│
├── backend/                     # Bot + API
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py             # FastAPI entry
│   │   ├── bot.py              # Telegram bot handlers
│   │   ├── config.py           # Settings
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   ├── user.py
│   │   │   ├── recipe.py
│   │   │   └── shared_list.py
│   │   ├── routers/
│   │   │   ├── __init__.py
│   │   │   ├── recipes.py      # Recipe API
│   │   │   ├── sharing.py      # Shared lists API
│   │   │   └── webhooks.py     # Telegram webhooks
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── notifications.py
│   │   │   └── recipe_matcher.py
│   │   └── database.py
│   ├── alembic/                # DB migrations
│   ├── requirements.txt
│   └── Dockerfile
│
├── data/
│   ├── recipes_uz.json         # Uzbek recipes
│   ├── recipes_ru.json         # Russian translations
│   └── items_catalog.json      # Common items
│
└── README.md
```

---

## 🎨 UI/UX Design

### Design Principles

1. **Mobile-first**: 99% of users on phones
2. **Thumb-friendly**: Important actions at bottom
3. **Minimal typing**: Buttons, sliders, presets
4. **Telegram-native**: Use theme colors, match Telegram style
5. **Fast**: Instant feedback, optimistic updates

### Color System (Theme-aware)

```css
/* Uses Telegram CSS variables automatically */
--tg-theme-bg-color           /* Background */
--tg-theme-text-color         /* Primary text */
--tg-theme-hint-color         /* Secondary text */
--tg-theme-button-color       /* Accent/buttons */
--tg-theme-secondary-bg-color /* Cards */
```

### Stock Level Colors

```
🟢 Green (#4CAF50): >60% — Well stocked
🟡 Yellow (#FFC107): 30-60% — Getting low
🔴 Red (#F44336): <30% — Need to buy!
```

### Navigation Pattern

```
┌─────────────────────────────────────┐
│  ← Back        UyBeka        ⚙️     │  ← Header (Telegram native)
├─────────────────────────────────────┤
│                                     │
│           Page Content              │
│                                     │
│                                     │
├─────────────────────────────────────┤
│  🏠    📦    🛒    🍲    │  ← Bottom navigation
│  Home  Stock  Shop  Cook            │
└─────────────────────────────────────┘
```

### Key Screens Mockup

**Dashboard:**
```
┌─────────────────────────────────────┐
│  Assalomu alaykum, Dilnoza! 👋      │
├─────────────────────────────────────┤
│                                     │
│  📊 Oshxona holati                  │
│  ┌─────────────────────────────┐    │
│  │ GO'SHT     ████████░░  80% │    │
│  │ GURUCH     ███░░░░░░░  30% │ ⚠️ │
│  │ UN         █████████░  90% │    │
│  │ YOG'       ██░░░░░░░░  20% │ 🔴 │
│  └─────────────────────────────┘    │
│                                     │
│  ⚠️ 3 ta mahsulot kam qoldi         │
│  [Ro'yxatni ko'rish →]              │
│                                     │
│  💡 Bugun nima pishiramiz?          │
│  [Tavsiyalar →]                     │
│                                     │
└─────────────────────────────────────┘
```

**Inventory Item:**
```
┌─────────────────────────────────────┐
│  🍚 Guruch (Rice)                   │
├─────────────────────────────────────┤
│                                     │
│  Miqdori:                           │
│  ┌───┐  2.5 kg  ┌───┐               │
│  │ - │ ════════ │ + │               │
│  └───┘          └───┘               │
│                                     │
│  Min. chegara: 1 kg                 │
│  ████████████░░░░░░░░  62%          │
│                                     │
│  [Saqlash]  [O'chirish]             │
└─────────────────────────────────────┘
```

---

## 🔌 Telegram Mini App Integration

### Initialization

```typescript
// src/hooks/useTelegram.ts
import { useEffect, useState } from 'react';

declare global {
  interface Window {
    Telegram: {
      WebApp: WebApp;
    };
  }
}

export function useTelegram() {
  const [webApp, setWebApp] = useState<WebApp | null>(null);
  const [user, setUser] = useState<WebAppUser | null>(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready(); // Tell Telegram we're ready
      tg.expand(); // Expand to full height
      setWebApp(tg);
      setUser(tg.initDataUnsafe?.user || null);
    }
  }, []);

  return {
    webApp,
    user,
    colorScheme: webApp?.colorScheme || 'light',
    themeParams: webApp?.themeParams,
    // Utility methods
    showAlert: (msg: string) => webApp?.showAlert(msg),
    showConfirm: (msg: string) => webApp?.showConfirm(msg),
    hapticFeedback: webApp?.HapticFeedback,
    cloudStorage: webApp?.CloudStorage,
    deviceStorage: webApp?.DeviceStorage,
  };
}
```

### CloudStorage Wrapper

```typescript
// src/hooks/useCloudStorage.ts
import { useTelegram } from './useTelegram';

export function useCloudStorage() {
  const { cloudStorage } = useTelegram();

  const setItem = (key: string, value: any): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      cloudStorage?.setItem(key, JSON.stringify(value), (err, success) => {
        if (err) reject(err);
        else resolve(success || false);
      });
    });
  };

  const getItem = <T>(key: string): Promise<T | null> => {
    return new Promise((resolve, reject) => {
      cloudStorage?.getItem(key, (err, value) => {
        if (err) reject(err);
        else resolve(value ? JSON.parse(value) : null);
      });
    });
  };

  const removeItem = (key: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      cloudStorage?.removeItem(key, (err, success) => {
        if (err) reject(err);
        else resolve(success || false);
      });
    });
  };

  return { setItem, getItem, removeItem };
}
```

### Main Button Usage

```typescript
// Example: Shopping list share button
const { webApp } = useTelegram();

useEffect(() => {
  if (webApp && shoppingList.length > 0) {
    webApp.MainButton.setText('Ro\'yxatni ulashish');
    webApp.MainButton.show();
    webApp.MainButton.onClick(() => {
      // Send data to bot
      const listText = shoppingList
        .map(item => `• ${item.name} - ${item.qty} ${item.unit}`)
        .join('\n');
      webApp.sendData(JSON.stringify({ 
        action: 'share_list', 
        list: listText 
      }));
    });
  }
  return () => webApp?.MainButton.hide();
}, [shoppingList]);
```

---

## 🗂️ Data Models

### Inventory Item (CloudStorage)

```typescript
// Key format: "inv_{itemId}"
interface InventoryItem {
  id: string;
  name: string;           // "Guruch"
  nameRu?: string;        // "Рис"
  category: Category;     // "grain"
  quantity: number;       // 2.5
  unit: Unit;             // "kg"
  minThreshold: number;   // 1.0 (alert below this)
  updatedAt: string;      // ISO timestamp
}

type Category = 
  | 'meat'      // Go'sht
  | 'vegetable' // Sabzavot
  | 'grain'     // Don mahsulotlari
  | 'dairy'     // Sut mahsulotlari
  | 'spice'     // Ziravorlar
  | 'oil'       // Yog'lar
  | 'other';    // Boshqa

type Unit = 'kg' | 'g' | 'l' | 'ml' | 'dona' | 'paket' | 'quti';
```

### Shopping List Item

```typescript
// Key: "shop_list"
interface ShoppingList {
  items: ShoppingItem[];
  createdAt: string;
  sharedWith?: number;    // Husband's Telegram ID
}

interface ShoppingItem {
  id: string;
  name: string;
  quantity: number;
  unit: Unit;
  isBought: boolean;
  boughtBy?: number;      // Telegram user ID
  boughtAt?: string;
}
```

### Recipe (Backend DB)

```typescript
interface Recipe {
  id: string;
  nameUz: string;         // "Mastava"
  nameRu: string;         // "Мастава"
  category: RecipeCategory;
  basePortions: number;   // 4
  prepTime: number;       // 90 (minutes)
  healthTags: string[];   // ["balanced", "warm"]
  ingredients: RecipeIngredient[];
  instructionsUz: string[];
  instructionsRu: string[];
  imageUrl?: string;
}

interface RecipeIngredient {
  itemName: string;       // Must match inventory item names
  quantity: number;
  unit: Unit;
}
```

---

## 🔄 User Flows

### Flow 1: First Launch

```
User opens Mini App link
    │
    ▼
┌─────────────────────────┐
│  Welcome Screen         │
│  • Language selection   │
│  • Quick tutorial       │
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│  Add Initial Items      │
│  • Common items preset  │
│  • Quick quantity set   │
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│  Dashboard              │
│  Ready to use!          │
└─────────────────────────┘
```

### Flow 2: Daily Usage (Wife)

```
Morning: Open Mini App
    │
    ▼
See Dashboard → Low stock alerts visible
    │
    ▼
Tap "Nima pishiramiz?" → See recipe suggestions
    │
    ▼
Select "Mastava" → View recipe
    │
    ▼
Tap "Pishirdim" → Ingredients auto-deducted
    │
    ▼
Evening: Tap 🛒 → Shopping list generated
    │
    ▼
Tap "Share" → Message sent to husband with list
```

### Flow 3: Shopping (Husband)

```
Receives Telegram message with list link
    │
    ▼
Opens same Mini App → Sees shared shopping list
    │
    ▼
At bazaar: Taps checkbox on each item as bought
    │
    ▼
Wife sees real-time updates (CloudStorage sync)
    │
    ▼
Husband taps "Done" → Wife gets notification
```

---

## 💬 Bot Integration

The bot serves as:
1. Entry point (sends Mini App link)
2. Notification sender
3. Sharing mechanism

### Bot Commands

```python
# Minimal commands — most interaction in Mini App
/start  → Opens Mini App link
/help   → Basic instructions
```

### Notification Messages

```python
# To husband when wife shares list
"🛒 Dilnoza sizga harid ro'yxatini yubordi!\n\n"
"• Guruch - 2 kg\n"
"• Sabzi - 1 kg\n"
"• Piyoz - 2 kg\n\n"
"[Ro'yxatni ochish]"  # Inline button → Mini App

# To wife when husband buys item
"✅ Aziz 'Guruch - 2 kg' sotib oldi!"
```

---

## 🌐 Localization

### Strings Structure

```typescript
// src/utils/i18n.ts
const strings = {
  uz: {
    // Navigation
    home: "Bosh sahifa",
    inventory: "Ombor",
    shopping: "Harid",
    recipes: "Retseptlar",
    settings: "Sozlamalar",
    
    // Dashboard
    greeting: "Assalomu alaykum",
    kitchenStatus: "Oshxona holati",
    lowStock: "Kam qolgan mahsulotlar",
    whatToCook: "Bugun nima pishiramiz?",
    
    // Inventory
    addItem: "Mahsulot qo'shish",
    quantity: "Miqdori",
    minThreshold: "Minimal chegara",
    save: "Saqlash",
    delete: "O'chirish",
    
    // Categories
    meat: "Go'sht",
    vegetable: "Sabzavotlar",
    grain: "Don mahsulotlari",
    dairy: "Sut mahsulotlari",
    spice: "Ziravorlar",
    oil: "Yog'lar",
    
    // Shopping
    shoppingList: "Harid ro'yxati",
    shareList: "Ro'yxatni ulashish",
    markBought: "Sotib olindi",
    
    // Recipes
    cookThis: "Buni pishiraman",
    portions: "Porsiya",
    ingredients: "Kerakli mahsulotlar",
    instructions: "Tayyorlash",
    
    // Alerts
    lowStockAlert: "Kam qoldi!",
    itemAdded: "Mahsulot qo'shildi",
    listShared: "Ro'yxat yuborildi",
  },
  ru: {
    // ... Russian translations
  }
};
```

---

## 📱 Mini App Setup in BotFather

```
1. /newbot → Create bot, get token
2. /setmenubutton → Set Mini App URL as menu button
3. /mybots → Select bot → Bot Settings → Configure Mini App
   • Enable Mini App
   • Set Mini App URL: https://your-domain.com
   • Upload app icon
   • Add screenshots/preview media
```

### Direct Link Format

```
# Opens in current chat
https://t.me/UyBekaBot?startapp

# Opens in specific mode
https://t.me/UyBekaBot?startapp=shopping
https://t.me/UyBekaBot?startapp=recipes
```

---

## 🚀 MVP Development Plan

### Week 1: Foundation

```
Day 1-2: Project setup
  • Create Vite + React project
  • Setup Tailwind CSS
  • Telegram SDK integration
  • Basic routing

Day 3-4: Core UI components
  • Button, Card, ProgressBar, Modal
  • Bottom navigation
  • Theme integration

Day 5-6: Inventory feature
  • CloudStorage integration
  • Add/edit/remove items
  • Category tabs
  • Stock level bars

Day 7: Polish & deploy
  • Deploy frontend (Vercel/Netlify)
  • Create bot with BotFather
  • Configure Mini App URL
```

### Week 2: Shopping & Share

```
Day 1-2: Shopping list
  • Auto-generate from low stock
  • Manual add items
  • Checkbox for bought status

Day 3-4: Bot integration
  • FastAPI backend setup
  • Webhook handler
  • Share list message

Day 5-7: Testing & refinement
  • Test on real devices
  • Fix UX issues
  • Beta with 5-10 users
```

---

## ✅ Success Metrics (MVP)

| Metric | Target (Month 1) |
|--------|------------------|
| Mini App opens | 200 |
| Active users (weekly) | 50 |
| Items tracked per user | 15+ |
| Shopping lists generated | 100 |
| Retention (7-day) | 40% |
| Home screen adds | 10% |

---

## 🛡️ Security Considerations

1. **Validate initData** on backend for sensitive operations
2. **User isolation**: Each user's CloudStorage is private
3. **Rate limiting** on backend API
4. **No sensitive data** in DeviceStorage (it's not encrypted)

---

## 📝 Notes for Claude Code

### Implementation Priority

1. **Start with frontend**: `frontend/src/App.tsx`, basic routing
2. **Telegram integration**: `frontend/src/hooks/useTelegram.ts`
3. **Inventory feature**: Components + CloudStorage
4. **Deploy early**: Get Mini App link working ASAP
5. **Add backend** only when needed for sharing

### Key Files to Create First

```
frontend/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── hooks/useTelegram.ts
│   ├── hooks/useCloudStorage.ts
│   ├── pages/HomePage.tsx
│   ├── pages/InventoryPage.tsx
│   └── components/ui/ProgressBar.tsx
```

### Testing Without Phone

1. Use Telegram Desktop beta (Windows/Linux) for WebView debugging
2. Or use `https://nicegram.app/` web client
3. BotFather test environment for development

---

*Last updated: January 2025*
*Version: 0.2 (Mini App Architecture)*
