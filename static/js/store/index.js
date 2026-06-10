const { reactive } = Vue;

// Mock Data for MVP
const INITIAL_ITEMS = [
    { id: 1, name: "Kartoshka", quantity: 5, unit: "kg", threshold: 2, category: "Sabzavot" },
    { id: 2, name: "Piyoz", quantity: 1, unit: "kg", threshold: 2, category: "Sabzavot" },
    { id: 3, name: "Un", quantity: 10, unit: "kg", threshold: 3, category: "Don" },
    { id: 4, name: "Yog'", quantity: 0.5, unit: "l", threshold: 1, category: "Yog'lar" }
];

export const store = reactive({
    items: JSON.parse(localStorage.getItem('uybeka_items')) || INITIAL_ITEMS,
    
    // Actions
    addItem(item) {
        this.items.push({ ...item, id: Date.now() });
        this.save();
    },
    updateQuantity(id, change) {
        const item = this.items.find(i => i.id === id);
        if (item) {
            item.quantity += change;
            if (item.quantity < 0) item.quantity = 0;
            this.save();
        }
    },
    save() {
        localStorage.setItem('uybeka_items', JSON.stringify(this.items));
    },
    get lowStockItems() {
        return this.items.filter(i => i.quantity <= i.threshold);
    }
});
